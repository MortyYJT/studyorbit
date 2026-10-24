import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AiPolicySchema, AssessmentSchema, AnnotationSchema, AnnotationVerdictSchema, AssessmentLinkSchema, type Annotation } from '../domain/schemas.js';
import { hash, citationMismatch, validateCitation } from '../citations/exact.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { courseEvidenceSnapshot } from '../revision/source-fetch.js';
import { IdSchema, HashSchema, CitationInputSchema, VerifiedCitationSchema, AnnotationFieldsSchema, CoverageSchema, CursorSchema } from './contracts.js';
import { TrustedStoreEvidence } from './reads.js';
import type { TrustedContext } from './context.js';
import { ok } from './envelope.js';
import { CourseworkError } from './errors.js';

const target = { entity: z.enum(['assessment', 'course']), entityId: IdSchema };
const citations = z.array(CitationInputSchema).min(1).max(100);
const field = z.enum(['weight', 'kind', 'hurdleMin', 'isFinal', 'name', 'due', 'assessmentsComplete', 'aiPolicy']);
const annotation = { ...target, field, value: z.json() };
const citedValue = <S extends z.ZodType>(value: S) => z.strictObject({ value, citations });
const receipt = z.strictObject({ id: IdSchema, citations: z.array(VerifiedCitationSchema).max(200) });
const verdicts = z.array(AnnotationVerdictSchema.strict());
const storedCitations = z.array(z.union([VerifiedCitationSchema, CitationInputSchema]));
// Read history can contain unavailable evidence; persisted agent rows still require citations.
const history = z.strictObject({ ...AnnotationSchema.shape, citations: storedCitations, verdicts, coverage: CoverageSchema });
export const annotationContracts = {
  'annotation.record': { input: z.strictObject({ ...annotation, citations, sourceRevision: HashSchema }), output: receipt, level: 0 },
  'annotation.owner.record': { input: z.strictObject({ ...annotation, citations: citations.optional(), sourceRevision: HashSchema.optional() }), output: receipt, level: 0 },
  'assessment.create': { input: z.strictObject({ courseId: IdSchema, sourceRevision: HashSchema,
    name: citedValue(z.string().trim().min(1).max(100000)), weight: citedValue(AssessmentSchema.shape.weight.unwrap()) }), output: receipt, level: 0 },
  'assessment.link': { input: z.strictObject({ assessmentId: IdSchema, sourceItemId: IdSchema, sourceRevision: HashSchema }), output: z.strictObject({ recorded: z.literal(true) }), level: 0 },
  'annotation.read': { input: z.strictObject({ ...target, limit: z.number().int().min(0).max(500).default(100), cursor: CursorSchema.optional() }),
    output: z.strictObject({ ...target, fields: AnnotationFieldsSchema, history: z.array(history).max(500),
      nextCursor: CursorSchema.optional(), coverage: CoverageSchema, links: z.array(AssessmentLinkSchema.strict()) }), level: 0 },
  'annotation.confirm': { input: z.strictObject({ ...target, field, annotationId: IdSchema }), output: z.strictObject({ recorded: z.literal(true) }), level: 0 },
  'annotation.replace': { input: z.strictObject({ ...annotation, annotationId: IdSchema }), output: z.strictObject({ recorded: z.literal(true) }), level: 0 },
} as const;
export type AnnotationCommand = keyof typeof annotationContracts;
const assessmentFields = ['weight', 'kind', 'hurdleMin', 'isFinal', 'name', 'due'] as const;
const courseFields = ['assessmentsComplete', 'aiPolicy'] as const;
const invalid = () => new CourseworkError('INVALID_INPUT', 'Invalid annotation or course binding.');
const conflict = () => new CourseworkError('CONFLICT', 'Annotation target changed; refresh before retrying.');

/** Append-only annotations share trusted source, privacy and dispatch ledger boundaries with study writes. */
export class AnnotationService {
  constructor(private readonly store: SqliteRepository, private readonly evidence: TrustedStoreEvidence) {}
  private target(entity: 'assessment' | 'course', id: string) {
    const value = entity === 'assessment' ? this.store.loadAssessment(id) : this.store.loadCourse(id);
    if (!value) throw new CourseworkError('NOT_FOUND', 'Annotation target not found.');
    const courseId = 'courseId' in value ? value.courseId : value.id;
    if (!this.store.loadCourse(courseId)) throw invalid();
    return { value, courseId };
  }
  private validateValue(entity: 'assessment' | 'course', field: string, value: unknown) {
    const schema = entity === 'course'
      // The owner's course policy is one of the policy values, or null to clear it (#180).
      ? field === 'assessmentsComplete' ? z.boolean() : field === 'aiPolicy' ? AiPolicySchema.nullable() : undefined
      : field === 'name' ? z.string().trim().min(1).max(100000)
        : field === 'kind' ? AssessmentSchema.shape.kind.nullable()
          : field === 'due' ? AssessmentSchema.shape.due.nullable()
            : assessmentFields.includes(field as typeof assessmentFields[number]) ? AssessmentSchema.shape[field as keyof typeof AssessmentSchema.shape] : undefined;
    if (!schema || !schema.safeParse(value).success) throw invalid();
  }
  private verify(courseId: string, revision: string | undefined, refs: z.infer<typeof citations>) {
    const snapshot = courseEvidenceSnapshot(this.store, this.evidence, courseId);
    if (snapshot.sourceRevision !== revision) return citationMismatch();
    return refs.map(ref => {
      const source = snapshot.sources.find(source => source.sourceItemId === ref.sourceItemId);
      if (!source || source.courseId !== courseId) return citationMismatch();
      return validateCitation(ref, { sourceItemId: source.sourceItemId, text: source.text, locator: source.locator,
        sourceHash: source.sourceHash, ...(source.page ? { page: source.page } : {}) });
    });
  }
  private safe(value: unknown) {
    if (JSON.stringify(this.evidence.protect(value)) !== JSON.stringify(value)) throw invalid();
  }
  read(input: unknown) {
    const data = annotationContracts['annotation.read'].input.parse(input);
    const { value, courseId } = this.target(data.entity, data.entityId);
    const rows = this.store.readAnnotations(data.entity, data.entityId);
    const sources = new Map<string, ReturnType<TrustedStoreEvidence['getSync']> | null>();
    const history = rows.map(row => {
      const gaps: { code: 'MISSING_EVIDENCE'; reference: string }[] = [];
      const citations = row.citations.flatMap(ref => {
        try {
          if (!sources.has(ref.sourceItemId)) {
            const item = this.store.loadSourceItem(ref.sourceItemId);
            sources.set(ref.sourceItemId, item && !item.removed && item.kind !== 'post' ? this.evidence.getSync(ref.sourceItemId) : null);
          }
          const source = sources.get(ref.sourceItemId);
          if (!source || source.courseId !== courseId) return citationMismatch();
          const verified = validateCitation({ sourceItemId: ref.sourceItemId, quote: ref.quote, locator: ref.locator },
            { sourceItemId: source.sourceItemId, text: source.text, sourceHash: source.sourceHash,
              locator: source.locator, ...(source.page !== undefined ? { page: source.page } : {}) });
          // A verified receipt must still resolve to the same text and offsets.
          if ('sourceHash' in ref && hash(ref) !== hash(verified)) return citationMismatch();
          return [verified];
        } catch (error) {
          if (!(error instanceof CourseworkError) || !['SOURCE_UNAVAILABLE', 'CITATION_MISMATCH'].includes(error.code)) throw error;
          gaps.push({ code: 'MISSING_EVIDENCE', reference: ref.sourceItemId });
          return [];
        }
      });
      return { ...row, citations, coverage: { complete: gaps.length === 0, gaps }, verdicts: this.store.readAnnotationVerdicts(row.id) };
    });
    const fields = Object.fromEntries((data.entity === 'assessment' ? assessmentFields : courseFields).map(field => {
      const candidates = history.filter(row => row.field === field);
      if (data.entity === 'course' && field === 'aiPolicy') {
        // Owner policy, else the agent-read value stored on the Course; an owner null clears the owner's policy (#180).
        const owner = candidates.filter(row => row.origin === 'owner' && (row.value === null || AiPolicySchema.safeParse(row.value).success)).at(-1);
        if (owner && owner.value !== null) return [field, { value: owner.value, origin: 'owner', annotationId: owner.id, citations: owner.citations, verdicts: owner.verdicts }];
        const read = (value as { aiPolicy?: string }).aiPolicy;
        return [field, { value: read ?? null, origin: read === undefined ? null : 'agent', citations: [], verdicts: [] }];
      }
      const effective = candidates.filter(row => row.origin === 'owner').at(-1) ?? candidates.filter(row => row.origin === 'agent' && row.coverage.complete).at(-1);
      // Agent-created facts are materialized for identity, not an independent sync fallback.
      const materializedAgentFact = 'origin' in value && value.origin === 'agent' && candidates.some(row => row.origin === 'agent');
      const fallback = materializedAgentFact ? undefined : (value as unknown as Record<string, unknown>)[field];
      return [field, effective ? { value: effective.value, origin: effective.origin, annotationId: effective.id,
        citations: effective.citations, verdicts: effective.verdicts } : { value: fallback ?? null,
        origin: fallback === undefined ? null : 'sync', citations: [], verdicts: [] }];
    }));
    const gaps = [...new Map(history.flatMap(row => row.coverage.gaps).map(gap => [gap.reference, gap])).values()];
    const base = { entity: data.entity, entityId: data.entityId, fields, coverage: { complete: gaps.length === 0, gaps },
      links: data.entity === 'assessment' ? this.store.currentAssessmentLinks(data.entityId) : [] };
    const digest = hash([data.entity, data.entityId, rows]);
    let offset = 0;
    if (data.cursor) {
      const decoded = Buffer.from(data.cursor, 'base64url').toString('utf8');
      const match = /^(\d+):([a-f0-9]{64})$/.exec(decoded);
      if (!match || Buffer.from(decoded).toString('base64url') !== data.cursor || match[2] !== digest
        || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= history.length) throw invalid();
      offset = Number(match[1]);
    }
    const page: typeof history = [];
    const result = () => ({ ...base, history: page, ...(data.limit > 0 && offset + page.length < history.length
      ? { nextCursor: Buffer.from(`${offset + page.length}:${digest}`).toString('base64url') } : {}) });
    for (const row of history.slice(offset, offset + data.limit)) {
      page.push(row);
      // Leave room for the dispatcher's measured envelope metadata.
      if (Buffer.byteLength(JSON.stringify(result())) > 60 * 1024 || !ok('annotation.read', result()).ok) {
        page.pop();
        if (!page.length) throw new CourseworkError('LIMIT_EXCEEDED', 'Read effective fields with limit 0.');
        break;
      }
    }
    const output = result();
    this.safe(output);
    return annotationContracts['annotation.read'].output.parse(output);
  }
  /** List consumers receive effective facts and field provenance; sync storage remains untouched. */
  project(entity: 'assessment' | 'course', value: { id: string }) {
    const detail = this.read({ entity, entityId: value.id, limit: 0 });
    const result: Record<string, unknown> = { ...value, fields: detail.fields, coverage: detail.coverage };
    for (const [field, effective] of Object.entries(detail.fields)) {
      if (field === 'aiPolicy') continue; // Policy text is an annotation, not an autonomy grant or Course field.
      if (effective.value === null) {
        if (field === 'name') throw new CourseworkError('SOURCE_UNAVAILABLE', 'Assessment name evidence is unavailable.');
        delete result[field];
      } else result[field] = effective.value;
    }
    return result;
  }
  async execute(name: AnnotationCommand, input: unknown, context: TrustedContext): Promise<unknown> {
    const parsed = annotationContracts[name].input.safeParse(input);
    if (!parsed.success) throw invalid();
    const data = parsed.data;
    if (name === 'annotation.read') return this.read(data);
    const owner = ['annotation.owner.record', 'annotation.confirm', 'annotation.replace'].includes(name);
    if (owner) {
      if (!context.owner) throw invalid();
      await context.owner.assertOwner(name);
    }
    // A course's AI policy is read into the course document, never annotated by an agent (#180).
    if (!owner && 'field' in data && data.field === 'aiPolicy') throw invalid();
    await context.authorization.check(name, 0, data);
    this.safe(data);
    const at = new Date().toISOString();
    if (name === 'assessment.create' && 'name' in data) {
      const refs = [...this.verify(data.courseId, data.sourceRevision, data.name.citations), ...this.verify(data.courseId, data.sourceRevision, data.weight.citations)];
      const id = randomUUID();
      const annotations: Annotation[] = ['name', 'weight'].map(field => ({ id: randomUUID(), entity: 'assessment', entityId: id, field,
        value: data[field as 'name' | 'weight'].value, origin: 'agent', at,
        citations: refs.filter(ref => data[field as 'name' | 'weight'].citations.some(c => hash(c) === hash({ sourceItemId: ref.sourceItemId, quote: ref.quote, locator: ref.locator }))) }));
      this.store.saveBatch({ assessments: [{ id, courseId: data.courseId, name: data.name.value, weight: data.weight.value, origin: 'agent', isFinal: false, status: 'not_started' }], annotations }, () => {
        this.verify(data.courseId, data.sourceRevision, [...data.name.citations, ...data.weight.citations]);
      });
      return { id, citations: refs };
    }
    if (name === 'assessment.link' && 'sourceItemId' in data) {
      const target = this.target('assessment', data.assessmentId);
      const source = this.store.loadSourceItem(data.sourceItemId);
      if (!source || source.courseId !== target.courseId || source.platform === 'manual' || source.removed) throw invalid();
      this.verify(target.courseId, data.sourceRevision, []);
      this.store.saveBatch({ assessmentLinks: [{ assessmentId: data.assessmentId, sourceItemId: data.sourceItemId, origin: 'agent', at }] }, () => {
        if (hash(this.store.loadSourceItem(data.sourceItemId)) !== hash(source) || hash(this.store.loadAssessment(data.assessmentId)) !== hash(target.value)) throw conflict();
        this.verify(target.courseId, data.sourceRevision, []);
      });
      return { recorded: true };
    }
    if (!('entity' in data) || !('field' in data)) throw invalid();
    const write = z.union([annotationContracts['annotation.record'].input, annotationContracts['annotation.owner.record'].input, annotationContracts['annotation.confirm'].input, annotationContracts['annotation.replace'].input]).parse(data);
    const target = this.target(write.entity, write.entityId);
    if ('value' in write) {
      this.validateValue(write.entity, write.field, write.value);
      // Policy values (and null, which clears them) change autonomy, which the owner may set only in the frontend.
      if (owner && write.entity === 'course' && write.field === 'aiPolicy') {
        await context.owner!.assertOwner('autonomy.policy.set');
      }
    }
    const refs = 'citations' in write && write.citations ? this.verify(target.courseId, write.sourceRevision, write.citations) : [];
    const judged = 'annotationId' in write ? this.read({ entity: write.entity, entityId: write.entityId, limit: 0 }).fields[write.field] : undefined;
    if ('annotationId' in write && (judged?.origin !== 'agent' || judged.annotationId !== write.annotationId)) throw conflict();
    const row: Annotation | undefined = 'value' in write ? { id: randomUUID(), entity: write.entity, entityId: write.entityId,
      field: write.field, value: write.value, origin: owner ? 'owner' : 'agent', citations: refs, at } : undefined;
    const before = hash(this.store.readAnnotations(write.entity, write.entityId));
    this.store.saveBatch({ ...(row ? { annotations: [row] } : {}), ...('annotationId' in write ? { annotationVerdicts: [{ annotationId: write.annotationId, verdict: name === 'annotation.confirm' ? 'correct' : 'incorrect', at }] } : {}) }, () => {
      if (hash(this.store.readAnnotations(write.entity, write.entityId)) !== before || hash(this.target(write.entity, write.entityId).value) !== hash(target.value)) throw conflict();
      if (refs.length) this.verify(target.courseId, 'sourceRevision' in write ? write.sourceRevision : undefined, 'citations' in write ? write.citations! : []);
    });
    return 'annotationId' in write ? { recorded: true } : { id: row!.id, citations: refs };
  }
}
