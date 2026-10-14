import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash } from '../citations/exact.js';
import { contracts, RevisionRecordSchema, PracticeRecordSchema, VerifiedCitationSchema, IdSchema, HashSchema, type CommandOutput } from './contracts.js';
import type { ProtocolServices, ServiceInput, TrustedContext, WriteCommand } from './context.js';
import { StudyCitationService, type StudyCommand, type StudyEvidenceProvider } from './citations.js';
import { CourseworkError } from './errors.js';
import { protectRead } from './read-privacy.js';

/** Accepted breakdown operational record; the Task copy is unchanged M1-compatible structure. */
export const BreakdownRecordSchema = z.strictObject({ id: IdSchema, revision: z.uuid(), previousRevision: z.uuid().optional(),
  assessmentId: IdSchema, sourceRevision: HashSchema, task: contracts['breakdown.write'].input.shape.task,
  citations: z.array(VerifiedCitationSchema).min(1).max(500), limitations: z.array(z.string().min(1)).max(100) });
export type StudyRecord = z.infer<typeof RevisionRecordSchema> | z.infer<typeof PracticeRecordSchema> | z.infer<typeof BreakdownRecordSchema>;
export const recordSchemas = { 'revision.write': RevisionRecordSchema, 'practice.write': PracticeRecordSchema, 'breakdown.write': BreakdownRecordSchema } as const;

/** Versioned operational persistence port. Implementations publish atomically and never via agent SQL.
 * `publish` is compare-and-swap: it must refuse unless the current revision equals `expected`.
 */
export interface StudyRecordStore {
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  current(command: StudyCommand, id: string): Promise<StudyRecord | undefined>;
  publish(command: StudyCommand, id: string, expected: string | undefined, record: StudyRecord): Promise<void>;
}
const conflict = () => new CourseworkError('CONFLICT', 'The accepted record or its sources changed; refresh before retrying.');
/** Synthetic/in-process store only. Production uses the SQLite implementation. */
export class InMemoryStudyRecordStore implements StudyRecordStore {
  private readonly records = new Map<string, StudyRecord>();
  private readonly locks = new Set<string>();
  size(): number { return this.records.size; }
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) throw new CourseworkError('LOCKED', 'Another write for this target is active.');
    this.locks.add(key);
    try { return await fn(); } finally { this.locks.delete(key); }
  }
  async current(command: StudyCommand, id: string): Promise<StudyRecord | undefined> {
    const value = this.records.get(`${command}:${id}`); return value && structuredClone(value);
  }
  async publish(command: StudyCommand, id: string, expected: string | undefined, record: StudyRecord): Promise<void> {
    if (this.records.get(`${command}:${id}`)?.revision !== expected) throw conflict();
    this.records.set(`${command}:${id}`, structuredClone(recordSchemas[command].parse(record)));
  }
}

const study = new Set<string>(['breakdown.write', 'revision.write', 'practice.write']);
/** Validated study writes at their registered levels. No model call, direct SQL or request-supplied evidence is accepted. */
export class StudyWriteService implements ProtocolServices {
  private readonly citations: StudyCitationService;
  private readonly privacy: (value: unknown) => unknown;
  constructor(private readonly options: { provider: StudyEvidenceProvider; store: StudyRecordStore; privacy?: (value: unknown) => unknown }) {
    this.citations = new StudyCitationService(options.provider);
    this.privacy = options.privacy ?? (value => protectRead(value));
  }
  async write<N extends WriteCommand>(name: N, input: ServiceInput<N>, context: TrustedContext): Promise<CommandOutput<N>> {
    if (!study.has(name)) throw new CourseworkError('SOURCE_UNAVAILABLE', 'The requested write service is unavailable.');
    const command = name as StudyCommand;
    const parsed = contracts[command].input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'Invalid study write.');
    const data = parsed.data;
    // Rechecked here so a direct service call cannot skip the registered authorization gate or privacy boundary.
    await context.authorization.check(command, contracts[command].level, data);
    let safe: unknown;
    try { safe = this.privacy(data); } catch { safe = undefined; }
    if (JSON.stringify(safe) !== JSON.stringify(data)) throw new CourseworkError('INVALID_INPUT', 'Study write contains unsafe personal or private text.');
    const target = 'task' in data ? { courseId: data.task.courseId!, assessmentId: data.assessmentId } : { courseId: data.courseId };
    const id = 'task' in data ? data.task.id : `${command.split('.')[0]}-${hash([data.courseId, data.week ?? null, ...('topics' in data ? ['exam-scope'] : [])]).slice(0, 32)}`;
    return this.options.store.exclusive(`${command}:${id}`, async () => {
      // Publication-time recheck: current source revision first, then every citation unit.
      const snapshot = await this.options.provider.resolve(target);
      if (snapshot.sourceRevision !== data.sourceRevision) throw conflict();
      const verified = await this.citations.validate(command, data);
      const current = await this.options.store.current(command, id);
      if (current?.revision !== data.previousRevision
        || current && 'assessmentId' in current && 'task' in data && current.assessmentId !== data.assessmentId) throw conflict();
      const revision = randomUUID();
      const base = { id, revision, sourceRevision: data.sourceRevision, ...(current ? { previousRevision: current.revision } : {}),
        citations: verified.citations, limitations: verified.limitations };
      const record: StudyRecord = 'task' in data ? { ...base, assessmentId: data.assessmentId, task: data.task }
        : 'topics' in data ? { ...base, courseId: data.courseId, type: 'exam-scope', ...(data.week !== undefined ? { week: data.week } : {}), topics: data.topics }
        : 'claims' in data ? { ...base, courseId: data.courseId, ...(data.week !== undefined ? { week: data.week } : {}), claims: data.claims, ...('type' in data ? { type: data.type } : {}) }
          : { ...base, courseId: data.courseId, ...(data.week !== undefined ? { week: data.week } : {}), questions: data.questions };
      const valid = recordSchemas[command].safeParse(record);
      if (!valid.success) throw new CourseworkError('INVALID_INPUT', 'Study write cannot be stored safely.');
      await this.options.store.publish(command, id, current?.revision, valid.data);
      return { id, revision, sourceRevision: data.sourceRevision, citations: verified.citations, limitations: verified.limitations } as CommandOutput<N>;
    });
  }
}
