import { materialMetadata } from '../revision/sources.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AcceptedRecordReader } from '../store/accepted-records.js';
import type { Repository } from '../store/repository.js';
import type { CurrentStateReader, Collection, QueryInput } from '../store/queries.js';
import { contracts, CoverageSchema, AnnotationFieldsSchema, SourceEvidenceSchema, IdSchema, HashSchema, type CommandOutput, type ParsedCommandInput } from './contracts.js';
import type { ProtocolRepository, ReadCommand } from './context.js';
import { CourseworkError, retryable } from './errors.js';
import { ok } from './envelope.js';

const invalidEvidence = () => new CourseworkError('SOURCE_UNAVAILABLE', 'Source integrity could not be verified.');

type Evidence = CommandOutput<'sources.get'>;
const metadataSchema = z.strictObject({ sourceItemId: IdSchema, courseId: IdSchema,
  provenance: z.enum(['canvas', 'ed', 'manual']), sourceHash: HashSchema,
  locator: z.string().min(1).max(100000), page: z.number().int().positive().safe().optional(), legacySourceItemId: IdSchema.optional() });
export type EvidenceMetadata = z.infer<typeof metadataSchema>;
export interface SourceEvidenceReader {
  get(sourceItemId: string): Promise<Evidence>;
}
/** Host-verified source-qualified identities and page metadata; never parsed from command arguments.
 * M1 contentHash hashes more than text and must not be reused as a citation text hash.
 */
export class TrustedStoreEvidence implements SourceEvidenceReader {
  private readonly metadata: readonly EvidenceMetadata[];
  constructor(private readonly store: Pick<Repository, 'loadSourceItem'>,
    options: { metadata?: readonly EvidenceMetadata[] } = {}) {
    const parsed = z.array(metadataSchema).safeParse(options.metadata ?? []);
    if (!parsed.success) throw invalidEvidence();
    this.metadata = structuredClone(parsed.data);
  }
  async get(id: string): Promise<Evidence> {
    return this.getSync(id);
  }
  getSync(id: string): Evidence {
    const matches = this.metadata.filter(m => m.sourceItemId === id || m.legacySourceItemId === id);
    if (matches.length > 1) throw invalidEvidence();
    const stored = this.store.loadSourceItem(id);
    const fetched = stored?.kind === 'material' ? materialMetadata(stored.externalId) : undefined;
    const metadata = matches[0] ?? (fetched && stored?.courseId ? { sourceItemId: id, courseId: stored.courseId, provenance: stored.platform, sourceHash: stored.contentHash, ...fetched } : undefined);
    if (metadata && metadata.sourceItemId !== id && this.store.loadSourceItem(id)) throw invalidEvidence();
    const source = this.store.loadSourceItem(metadata?.sourceItemId ?? id);
    if (!source || !source.courseId || metadata && (metadata.courseId !== source.courseId || metadata.provenance !== source.platform)) throw invalidEvidence();
    // No page number or cross-provider identity is guessed from a source title, code or URL.
    if (source.kind === 'material' && !metadata) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Material page metadata is unavailable.');
    const storedHash = createHash('sha256').update(source.text).digest('hex');
    if (metadata && metadata.sourceHash !== storedHash) throw invalidEvidence();
    // Citation hashes/UTF-16 offsets are based only on the exact model-facing text.
    const sourceHash = storedHash;
    let locator = metadata?.locator ?? source.id;
    if (metadata?.page !== undefined) {
      if (locator !== `page:${metadata.page}` && locator !== `page ${metadata.page}`) throw invalidEvidence();
      locator = `page:${metadata.page}`;
    } else if (/^page[: ]/i.test(locator)) throw invalidEvidence();
    const evidence = SourceEvidenceSchema.parse({ sourceItemId: source.id, courseId: source.courseId,
      text: source.text, sourceHash, locator, ...(metadata?.page !== undefined ? { page: metadata.page } : {}),
      provenance: source.platform, ...(source.url ? { url: source.url } : {}), ...(source.copiedBy ? { copiedBy: source.copiedBy } : {}) });
    return evidence;
  }
}
export interface AuxiliaryReadPorts {
  assessments?: { query(input: QueryInput<'assessments'>): ReturnType<CurrentStateReader['query']> };
  project?: (entity: 'course' | 'assessment', value: { id: string }) => unknown;
  accepted?: AcceptedRecordReader;
  revision?: { read<N extends 'revision.read' | 'practice.stats'>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>> };
  /** Future D audit adapter and existing Q1 managed-profile read, explicitly mounted by a host. */
  audit?: { read(input: ParsedCommandInput<'audit.list'>): Promise<CommandOutput<'audit.list'>> };
  /** M1 entities do not store source links except Task citations; never infer them by name. */
  entitySources?: (collection: 'courses' | 'assessments', id: string) => readonly string[];
  /** Linked platform state and points only when exactly one current linked item states both; no item text is returned. */
  platform?: (assessmentId: string) => { linked: boolean; submitted: boolean; removed: boolean; pointsEarned?: number; pointsPossible?: number };
}
type Gap = { code: 'MISSING_EVIDENCE' | 'UNSUPPORTED' | 'INCOMPLETE'; reference?: string };
const unsupported = () => ({ items: [], evidence: [], coverage: { complete: false, gaps: [{ code: 'UNSUPPORTED' }] } });
const unavailable = () => new CourseworkError('SOURCE_UNAVAILABLE', 'The requested read adapter or source is unavailable.');
/** ReadCommand implementation only: no transports, authorization services or business writes. */
export class StoreProtocolReads implements ProtocolRepository {
  constructor(private readonly store: CurrentStateReader & Pick<Repository, 'loadSourceItem'>,
    private readonly evidence: SourceEvidenceReader, private readonly ports: AuxiliaryReadPorts = {}) {}

  async read<N extends ReadCommand>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>> {
    const parsed = contracts[name].input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'Invalid read filters or continuation.');
    try {
      const raw = await this.execute(name, parsed.data);
      const validated = contracts[name].output.parse(raw);
      const output = validated as CommandOutput<N>;
      if (!ok(name, output).ok) throw new CourseworkError('LIMIT_EXCEEDED', 'The read exceeds the response bound.');
      return output;
    } catch (error) {
      const code = error instanceof CourseworkError && Object.hasOwn(retryable, error.code) ? error.code : 'INTERNAL';
      throw new CourseworkError(code, code === 'INVALID_INPUT' ? 'Invalid read continuation.' : 'The requested read could not complete safely.');
    }
  }
  private async execute(name: ReadCommand, input: unknown): Promise<unknown> {
    if (name === 'revision.read' || name === 'practice.stats') {
      if (!this.ports.revision) throw unavailable();
      return this.ports.revision.read(name, input as never);
    }
    if (name === 'sources.get') return this.evidence.get((input as ParsedCommandInput<'sources.get'>).sourceItemId);
    if (name === 'revision.list' || name === 'practice.list') {
      if (!this.ports.accepted) { return unsupported(); }
      const value = contracts[name].output.parse(await this.ports.accepted.read(name, input as never));
      const filters = input as ParsedCommandInput<'revision.list'>;
      if ('items' in value) {
        if (value.items.length > filters.limit || value.items.some(item => item.courseId !== filters.courseId
          || filters.week !== undefined && item.week !== filters.week
          || filters.revision !== undefined && item.revision !== filters.revision)) throw unavailable();
        for (const supplied of value.evidence) {
          const resolved = await this.evidence.get(supplied.sourceItemId);
          if (resolved.courseId !== filters.courseId || JSON.stringify(resolved) !== JSON.stringify(supplied)) throw unavailable();
        }
      }
      return value;
    }
    if (name === 'audit.list') return this.ports.audit ? this.ports.audit.read(input as ParsedCommandInput<'audit.list'>) : unsupported();
    return this.list(name, input as Record<string, unknown> & { limit: number; cursor?: string });
  }
  private async list(name: ReadCommand, input: Record<string, unknown> & { limit: number; cursor?: string }) {
    const collections: Partial<Record<ReadCommand, Collection>> = ({ 'courses.list': 'courses', 'assessments.list': 'assessments', 'tasks.list': 'tasks',
      'runs.list': 'runs', 'materials.list': 'sourceItems' });
    const collection = collections[name];
    if (!collection) throw unavailable();
    const { cursor: initial, limit, page: requestedPage, sourceItemId, ...filters } = input;
    if (collection === 'sourceItems') {
      filters.kind = 'material';
      filters.continuationScope = JSON.stringify({ page: requestedPage ?? null, sourceItemId: sourceItemId ?? null });
      if (sourceItemId !== undefined) {
        const resolved = await this.evidence.get(sourceItemId as string);
        if (resolved.courseId !== filters.courseId) throw unavailable();
        filters.id = resolved.sourceItemId;
      }
    }
    const items: unknown[] = []; const evidence: Evidence[] = []; const gaps: Gap[] = [];
    let cursor = initial;
    for (let count = 0; count < limit; count++) {
      const current = collection === 'assessments' && this.ports.assessments
        ? this.ports.assessments.query({ ...filters, limit: 1, cursor })
        : this.store.query(collection, { ...filters, limit: 1, cursor } as QueryInput<Collection>);
      const item = current.items[0];
      if (!item) { cursor = undefined; break; }
      const itemEvidence: Evidence[] = []; const itemGaps: Gap[] = [];
      let included: unknown =
        (collection === 'courses' || collection === 'assessments') && this.ports.project
          ? this.ports.project(collection === 'courses' ? 'course' : 'assessment', item) : item;
      if (collection === 'assessments' && this.ports.platform && included && typeof included === 'object') {
        included = { ...included, platform: this.ports.platform(item.id) };
      }
      if ((collection === 'courses' || collection === 'assessments') && included && typeof included === 'object' && 'coverage' in included) {
        itemGaps.push(...CoverageSchema.parse(included.coverage).gaps);
        const { coverage: _coverage, ...projected } = included;
        included = projected;
      }
      if (collection === 'sourceItems') {
        try {
          const resolved = await this.evidence.get(item.id);
          included = requestedPage === undefined || requestedPage === resolved.page ? resolved : undefined;
        } catch (error) {
          // Unsupported material coverage is visible; unsafe/malformed evidence is never exported.
          if (!(error instanceof CourseworkError) || error.code !== 'SOURCE_UNAVAILABLE') throw error;
          included = undefined; itemGaps.push({ code: 'UNSUPPORTED', reference: item.id });
        }
      } else if (collection !== 'runs') {
        const fieldRefs = included && typeof included === 'object' && 'fields' in included
          ? Object.values(AnnotationFieldsSchema.parse(included.fields)).flatMap(field => field.citations.map(ref => ref.sourceItemId)) : [];
        const refs = [...new Set([...fieldRefs, ...(collection === 'tasks' ? [...new Set(('steps' in item && Array.isArray(item.steps) ? item.steps : []).flatMap(s => s.citations.map(c => c.sourceItemId)))]
          : this.ports.entitySources?.(collection as 'courses' | 'assessments', item.id) ?? [])])];
        if (!refs.length && (collection !== 'tasks' || 'source' in item && item.source === 'coursework')) itemGaps.push({ code: 'MISSING_EVIDENCE', reference: item.id });
        for (const ref of refs) {
          try {
            const resolved = await this.evidence.get(ref);
            const courseId = collection === 'courses' ? item.id : 'courseId' in item ? item.courseId : undefined;
            if (!courseId || resolved.courseId !== courseId) throw unavailable();
            itemEvidence.push(resolved);
          } catch (error) {
            if (!(error instanceof CourseworkError) || error.code !== 'SOURCE_UNAVAILABLE') throw error;
            itemGaps.push({ code: 'MISSING_EVIDENCE', reference: ref });
          }
        }
        if (included && typeof included === 'object' && 'assessmentsComplete' in included && !included.assessmentsComplete) itemGaps.push({ code: 'INCOMPLETE', reference: item.id });
      }
      const nextItems = [...items, ...(included === undefined ? [] : [included])];
      const nextEvidence = [...new Map([...evidence, ...itemEvidence].map(e => [e.sourceItemId, e])).values()];
      const nextGaps = [...gaps, ...itemGaps];
      const candidate = { items: nextItems, evidence: nextEvidence, coverage: { complete: nextGaps.length === 0, gaps: nextGaps },
        ...(current.nextCursor ? { nextCursor: current.nextCursor } : {}) };
      // Check both contract bounds and the shared envelope bound before advancing the owning cursor.
      if (!contracts[name].output.safeParse(candidate).success || !ok(name, candidate).ok
        || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 64 * 1024 - 1024) {
        if (count === 0) throw new CourseworkError('LIMIT_EXCEEDED', 'A single read item exceeds the response bound.');
        break;
      }
      items.splice(0, items.length, ...nextItems); evidence.splice(0, evidence.length, ...nextEvidence); gaps.push(...itemGaps);
      cursor = current.nextCursor;
      if (!cursor) break;
    }
    return { items, evidence, coverage: { complete: gaps.length === 0, gaps }, ...(cursor ? { nextCursor: cursor } : {}) };
  }
}
