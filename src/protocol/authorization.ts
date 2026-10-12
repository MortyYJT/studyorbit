import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PolicyRecordSchema, GrantRecordSchema, IdSchema, type Level, type CommandOutput } from './contracts.js';
import type { AuthorizationService, OwnerInteraction, AuditEvent, ProtocolServices, WriteCommand, ServiceInput, TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';
import { enforceAuthorization, denyAuthorization, type AuthorizationTarget } from './authorization-rules.js';
import { bindingSchema, policySchema, grantSchema, type Binding } from '../quiz/policy.js';
import { edId } from '../quiz/read/contracts.js';
import { QuizFiles } from '../quiz/files.js';
import { hash } from '../quiz/citations.js';
type Policy = z.infer<typeof PolicyRecordSchema>;
type Grant = z.infer<typeof GrantRecordSchema>;
const identitySchema = z.strictObject({
  courses: z.array(z.strictObject({ courseId: IdSchema, edCourse: edId })),
  assessments: z.array(z.strictObject({ assessmentId: IdSchema, courseId: IdSchema, binding: bindingSchema })),
});
/** Trusted, explicit provenance mapping. No titles, inferred IDs, or last-writer-wins ambiguity. */
export class IdentityMap {
  private readonly data!: z.infer<typeof identitySchema>;
  constructor(input: z.input<typeof identitySchema>) {
    const parsed = identitySchema.safeParse(input); if (!parsed.success) return denyAuthorization();
    this.data = parsed.data;
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (!unique(this.data.courses.map(c => c.courseId)) || !unique(this.data.courses.map(c => c.edCourse))
      || !unique(this.data.assessments.map(a => a.assessmentId)) || !unique(this.data.assessments.map(a => a.binding.assessmentId))
      || !unique(this.data.assessments.map(a => `${a.binding.course}:${a.binding.lesson}`))
      || this.data.assessments.some(a => !this.data.courses.some(c => c.courseId === a.courseId && c.edCourse === a.binding.course))) denyAuthorization();
  }
  course(id: string) { const value = this.data.courses.find(c => c.courseId === id); if (!value) return denyAuthorization(); return { ...value }; }
  legacyCourse(id: string) { const value = this.data.courses.find(c => c.edCourse === id); if (!value) return denyAuthorization(); return { ...value }; }
  assessment(id: string) { const value = this.data.assessments.find(a => a.assessmentId === id); if (!value) return denyAuthorization(); return structuredClone(value); }
  legacyAssessment(binding: Binding) {
    const value = this.data.assessments.find(a => hash(a.binding) === hash(binding)); if (!value) return denyAuthorization(); return structuredClone(value);
  }
}
export interface AuthorizationStore {
  target(id: string, recording?: boolean): Promise<AuthorizationTarget>;
  policy(courseId: string): Promise<{ record: Policy; ref: string } | undefined>;
  grant(assessmentId: string): Promise<{ record: Grant; ref: string } | undefined>;
  policyReference(record: Policy): string;
  grantReference(record: Grant): string;
  savePolicy(record: Policy): Promise<string>;
  saveGrant(record: Grant): Promise<string>;
  course(courseId: string): void;
  normalizePolicy(input: unknown): Policy;
  normalizeGrant(input: unknown): Grant;
  resolve(input: unknown): Promise<AuthorizationTarget>;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}
/** O3: existing Q1 files remain the sole authority. No activation marker, migration or copied records. */
export class Q1AuthorizationStore implements AuthorizationStore {
  constructor(private readonly files: QuizFiles, readonly identities: IdentityMap) {}
  course(id: string): void { this.identities.course(id); }
  exclusive<T>(fn: () => Promise<T>): Promise<T> { return this.files.exclusive(fn); }
  async target(id: string, recording?: boolean): Promise<AuthorizationTarget> {
    const mapping = this.identities.assessment(id);
    const raw = await this.files.read(`binding-${hash(mapping.binding.assessmentId)}`);
    if (recording && raw === undefined) return { courseId: mapping.courseId, assessmentId: mapping.assessmentId, category: mapping.binding.category };
    const current = bindingSchema.safeParse(raw);
    if (!current.success || hash(current.data) !== hash(mapping.binding)) return denyAuthorization();
    return { courseId: mapping.courseId, assessmentId: mapping.assessmentId, category: current.data.category };
  }
  normalizePolicy(input: unknown): Policy {
    const canonical = PolicyRecordSchema.safeParse(input); if (canonical.success) { this.course(canonical.data.courseId); return canonical.data; }
    const legacy = policySchema.safeParse(input); if (!legacy.success) return denyAuthorization();
    const { course, ...rest } = legacy.data;
    return PolicyRecordSchema.parse({ ...rest, courseId: this.identities.legacyCourse(course).courseId });
  }
  normalizeGrant(input: unknown): Grant {
    const canonical = GrantRecordSchema.safeParse(input); if (canonical.success) return canonical.data;
    const legacy = grantSchema.safeParse(input); if (!legacy.success) return denyAuthorization();
    const mapping = this.identities.legacyAssessment(legacy.data.binding);
    return GrantRecordSchema.parse({ version: 1, courseId: mapping.courseId, assessmentId: mapping.assessmentId,
      category: mapping.binding.category, level: legacy.data.level, date: legacy.data.date });
  }
  async resolve(input: unknown): Promise<AuthorizationTarget> {
    const fields = z.object({ assessmentId: IdSchema.optional(), courseId: IdSchema.optional(), binding: bindingSchema.optional() }).safeParse(input);
    if (!fields.success) return denyAuthorization();
    const { assessmentId, courseId, binding } = fields.data;
    const id = binding ? this.identities.legacyAssessment(binding).assessmentId : assessmentId;
    if (!id || assessmentId !== undefined && assessmentId !== id) return denyAuthorization();
    const target = await this.target(id); if (courseId !== undefined && courseId !== target.courseId) return denyAuthorization();
    return target;
  }
  async policy(courseId: string) {
    const mapping = this.identities.course(courseId); const raw = await this.files.read(`policy-${mapping.edCourse}`);
    if (raw === undefined) return undefined;
    const legacy = policySchema.safeParse(raw); if (!legacy.success || legacy.data.course !== mapping.edCourse) return denyAuthorization();
    return { record: this.normalizePolicy(legacy.data), ref: hash(raw) };
  }
  async grant(id: string) {
    const mapping = this.identities.assessment(id); const raw = await this.files.read(`grant-${hash(mapping.binding.assessmentId)}`);
    if (raw === undefined) return undefined;
    const legacy = grantSchema.safeParse(raw); if (!legacy.success || hash(legacy.data.binding) !== hash(mapping.binding)) return denyAuthorization();
    return { record: this.normalizeGrant(legacy.data), ref: hash(raw) };
  }
  private legacyPolicy(record: Policy) {
    const { courseId, ...rest } = record;
    return policySchema.parse({ ...rest, course: this.identities.course(courseId).edCourse });
  }
  private legacyGrant(record: Grant) {
    const mapping = this.identities.assessment(record.assessmentId);
    if (record.courseId !== mapping.courseId || record.category !== mapping.binding.category) return denyAuthorization();
    return grantSchema.parse({ version: 1, binding: mapping.binding, level: record.level, date: record.date });
  }
  policyReference(record: Policy): string { return hash(this.legacyPolicy(record)); }
  grantReference(record: Grant): string { return hash(this.legacyGrant(record)); }
  async savePolicy(record: Policy) {
    const raw = this.legacyPolicy(record);
    await this.files.write(`policy-${raw.course}`, raw); return hash(raw);
  }
  async saveGrant(record: Grant) {
    const raw = this.legacyGrant(record); const { binding } = raw;
    await this.target(record.assessmentId, true);
    const previousBinding = await this.files.read(`binding-${hash(binding.assessmentId)}`);
    let published = false;
    try {
      // An orphan grant cannot authorize until binding activation; never activate an old orphan first.
      await this.files.write(`grant-${hash(binding.assessmentId)}`, raw); published = true;
      if (previousBinding === undefined) await this.files.write(`binding-${hash(binding.assessmentId)}`, binding);
      return hash(raw);
    } catch (error) {
      if (published || error instanceof CourseworkError && error.code === 'UNCERTAIN') {
        throw new CourseworkError('UNCERTAIN', 'Grant publication could not be fully recorded; inspect private state before retrying.');
      }
      throw error;
    }
  }
}
export interface AutoSubmitSettings {
  get(courseId: string): Promise<boolean>;
  set(courseId: string, enabled: boolean): Promise<void>;
}
export class SharedAuthorization implements AuthorizationService {
  constructor(private readonly store: AuthorizationStore, private readonly audit: { record(event: AuditEvent): Promise<void> },
    private readonly settings?: AutoSubmitSettings) {}
  async check(_command: string, level: Level, input: unknown): Promise<void> {
    if (level <= 1) { enforceAuthorization(level); return; }
    const target = await this.store.resolve(input);
    const policy = await this.store.policy(target.courseId); const grant = await this.store.grant(target.assessmentId);
    enforceAuthorization(level, target, policy?.record, grant?.record);
    const refs = z.object({ policyRef: z.string().optional(), grantRef: z.string().optional() }).safeParse(input);
    if (!refs.success || refs.data.policyRef !== undefined && refs.data.policyRef !== policy?.ref
      || refs.data.grantRef !== undefined && refs.data.grantRef !== grant?.ref) throw new CourseworkError('CONFLICT', 'Authorization references changed.');
  }
  async references(_command: string, level: Level, input: unknown): Promise<Pick<AuditEvent, 'courseId' | 'assessmentId' | 'revision' | 'policyRef' | 'grantRef'>> {
    if (level <= 1) return {};
    let target: AuthorizationTarget;
    try { target = await this.store.resolve(input); } catch { return {}; }
    // Keep verified target metadata on denial, but never hash malformed authorization records.
    const policy = await this.store.policy(target.courseId).catch(() => undefined);
    const grant = await this.store.grant(target.assessmentId).catch(() => undefined);
    const parsed = z.object({ revision: z.uuid().optional() }).safeParse(input);
    const revision = parsed.success ? parsed.data.revision : undefined;
    return { courseId: target.courseId, assessmentId: target.assessmentId, ...(revision ? { revision } : {}),
      ...(policy ? { policyRef: policy.ref } : {}), ...(grant ? { grantRef: grant.ref } : {}) };
  }
  private async recording<T>(command: string, owner: OwnerInteraction | undefined, fn: (event: AuditEvent, intent: () => Promise<void>) => Promise<T>): Promise<T> {
    const event: AuditEvent = { command, runId: randomUUID(), phase: 'intent', code: 'OK' }; let completed = false;
    try {
      if (!owner) return denyAuthorization(); await owner.assertOwner(command);
      return await this.store.exclusive(async () => {
        const result = await fn(event, () => this.audit.record(event)); completed = true;
        await this.audit.record({ ...event, phase: 'outcome' }); return result;
      });
    } catch (error) {
      const uncertain = completed || error instanceof CourseworkError && error.code === 'UNCERTAIN';
      const code = uncertain ? 'UNCERTAIN' : error instanceof CourseworkError ? error.code : 'INTERNAL';
      try { await this.audit.record({ ...event, phase: uncertain ? 'outcome' : 'denial', code }); }
      catch { /* The original failure remains safe and no mutation is repeated. */ }
      throw new CourseworkError(code, uncertain ? 'Recording may have completed but its audit outcome is uncertain; inspect local state before retrying.' : 'Authorization recording failed safely.');
    }
  }
  recordPolicy(input: unknown, owner?: OwnerInteraction): Promise<CommandOutput<'policy.record'>> {
    return this.recording('policy.record', owner, async (event, intent) => {
      const record = this.store.normalizePolicy(input); event.courseId = record.courseId; event.policyRef = this.store.policyReference(record); await intent(); const policyRef = await this.store.savePolicy(record); event.policyRef = policyRef;
      return { recorded: 'policy', policyRef, courseId: record.courseId, status: record.status, cap: record.cap as 1 | 2 | 3 | 4, recordedAt: new Date().toISOString() } as CommandOutput<'policy.record'>;
    });
  }
  recordGrant(input: unknown, owner?: OwnerInteraction): Promise<CommandOutput<'grant.record'>> {
    return this.recording('grant.record', owner, async (event, intent) => {
      const record = this.store.normalizeGrant(input); event.courseId = record.courseId; event.assessmentId = record.assessmentId; const target = await this.store.target(record.assessmentId, true);
      if (target.courseId !== record.courseId || target.category !== record.category) return denyAuthorization();
      const policy = record.level > 1 ? await this.store.policy(record.courseId) : undefined;
      if (record.level > 1) enforceAuthorization(record.level, target, policy?.record, record);
      if (policy) event.policyRef = policy.ref;
      event.grantRef = this.store.grantReference(record);
      await intent();
      const grantRef = await this.store.saveGrant(record); event.grantRef = grantRef; event.assessmentId = record.assessmentId;
      return { recorded: 'grant', grantRef, courseId: record.courseId, assessmentId: record.assessmentId, category: record.category,
        level: record.level, recordedAt: new Date().toISOString() };
    });
  }
  async autoSubmit(courseId: string): Promise<boolean> { this.store.course(courseId); return this.settings ? (await this.settings.get(courseId)) === true : false; }
  setAutoSubmit(courseId: string, enabled: boolean, owner?: OwnerInteraction): Promise<void> {
    return this.recording('auto.submit', owner, async (event, intent) => {
      this.store.course(courseId); if (typeof enabled !== 'boolean') return denyAuthorization();
      if (!this.settings) throw new CourseworkError('SOURCE_UNAVAILABLE', 'No durable course setting store is installed.');
      event.courseId = courseId; await intent();
      await this.settings.set(courseId, enabled);
    });
  }
  /** Mount recording only; H/I supply unrelated writes rather than silently accepting them. */
  readonly services: ProtocolServices = {
    write: async <N extends WriteCommand>(name: N, input: ServiceInput<N>, context: TrustedContext): Promise<CommandOutput<N>> => {
      if (name === 'policy.record') return await this.recordPolicy(input, context.owner) as CommandOutput<N>;
      if (name === 'grant.record') return await this.recordGrant(input, context.owner) as CommandOutput<N>;
      throw new CourseworkError('SOURCE_UNAVAILABLE', 'The requested write service is unavailable.');
    },
  };
}
