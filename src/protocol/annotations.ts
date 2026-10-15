import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssessmentSchema, AnnotationSchema, AnnotationVerdictSchema, AssessmentLinkSchema, type Annotation } from '../domain/schemas.js';
import { hash, citationMismatch, validateCitation } from '../citations/exact.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { courseEvidenceSnapshot } from '../revision/source-fetch.js';
import { IdSchema, HashSchema, CitationInputSchema, VerifiedCitationSchema } from './contracts.js';
import { TrustedStoreEvidence } from './reads.js';
import type { TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';

const target = { entity: z.enum(['assessment', 'course']), entityId: IdSchema };
const citations = z.array(CitationInputSchema).min(1).max(100);
const field = z.enum(['weight', 'kind', 'hurdleMin', 'isFinal', 'name', 'due', 'assessmentsComplete', 'aiPolicy']);
const annotation = { ...target, field, value: z.json() };
const citedValue = <S extends z.ZodType>(value: S) => z.strictObject({ value, citations });
const receipt = z.strictObject({ id: IdSchema, citations: z.array(VerifiedCitationSchema).max(200) });
const verdicts = z.array(AnnotationVerdictSchema.strict());
const storedCitations = z.array(z.union([VerifiedCitationSchema, CitationInputSchema]));
const history = AnnotationSchema.safeExtend({ citations: storedCitations }).safeExtend({ verdicts });
export const annotationContracts = {
  'annotation.record': { input: z.strictObject({ ...annotation, citations, sourceRevision: HashSchema }), output: receipt, level: 0 },
  'annotation.owner.record': { input: z.strictObject({ ...annotation, citations: citations.optional(), sourceRevision: HashSchema.optional() }), output: receipt, level: 0 },
  'assessment.create': { input: z.strictObject({ courseId: IdSchema, sourceRevision: HashSchema,
    name: citedValue(z.string().trim().min(1).max(100000)), weight: citedValue(AssessmentSchema.shape.weight.unwrap()) }), output: receipt, level: 0 },
  'assessment.link': { input: z.strictObject({ assessmentId: IdSchema, sourceItemId: IdSchema, sourceRevision: HashSchema }), output: z.strictObject({ recorded: z.literal(true) }), level: 0 },
  'annotation.read': { input: z.strictObject(target), output: z.strictObject({ ...target,
    fields: z.record(z.string(), z.strictObject({ value: z.json(), origin: z.enum(['owner', 'agent', 'sync']).nullable(),
      annotationId: IdSchema.optional(), citations: storedCitations, verdicts })), history: z.array(history), links: z.array(AssessmentLinkSchema.strict()) }), level: 0 },
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
      ? field === 'assessmentsComplete' ? z.boolean() : field === 'aiPolicy' ? z.string().trim().min(1).max(100000) : undefined
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
    const { value } = this.target(data.entity, data.entityId);
    const rows = this.store.readAnnotations(data.entity, data.entityId);
    const history = rows.map(row => ({ ...row, verdicts: this.store.readAnnotationVerdicts(row.id) }));
    const fields = Object.fromEntries((data.entity === 'assessment' ? assessmentFields : courseFields).map(field => {
      const candidates = history.filter(row => row.field === field);
      const effective = candidates.filter(row => row.origin === 'owner').at(-1) ?? candidates.filter(row => row.origin === 'agent').at(-1);
      const fallback = (value as unknown as Record<string, unknown>)[field];
      return [field, effective ? { value: effective.value, origin: effective.origin, annotationId: effective.id,
        citations: effective.citations, verdicts: effective.verdicts } : { value: fallback ?? null,
        origin: fallback === undefined ? null : 'sync', citations: [], verdicts: [] }];
    }));
    const result = { ...data, fields, history, links: data.entity === 'assessment' ? this.store.currentAssessmentLinks(data.entityId) : [] };
    this.safe(result);
    return annotationContracts['annotation.read'].output.parse(result);
  }
  /** List consumers receive effective facts; sync storage remains untouched. Detail reads carry history/evidence. */
  project(entity: 'assessment' | 'course', value: { id: string }) {
    const detail = this.read({ entity, entityId: value.id });
    const result: Record<string, unknown> = { ...value };
    for (const [field, effective] of Object.entries(detail.fields)) {
      if (field === 'aiPolicy') continue; // Policy text is an annotation, not an autonomy grant or Course field.
      if (effective.value === null) delete result[field]; else result[field] = effective.value;
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
      // Enum policy values also change autonomy, which the owner may set only in the frontend.
      if (owner && write.entity === 'course' && write.field === 'aiPolicy' && ['allowed', 'prohibited', 'owner-attested'].includes(String(write.value))) {
        await context.owner!.assertOwner('autonomy.policy.set');
      }
    }
    const refs = 'citations' in write && write.citations ? this.verify(target.courseId, write.sourceRevision, write.citations) : [];
    const judged = 'annotationId' in write ? this.read({ entity: write.entity, entityId: write.entityId }).fields[write.field] : undefined;
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
