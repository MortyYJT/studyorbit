import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repository } from '../store/repository.js';
import { AssessmentSchema } from '../domain/schemas.js';
import { hash } from '../citations/exact.js';
import type { AuditEvent, TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';

// Input syntax only; audit references come from trusted target resolution.
export const AuditIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/);
export const WorkLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const PolicySchema = z.enum(['allowed', 'prohibited', 'owner-attested']);
export const ReasonSchema = z.enum(['allowed', 'assessment-unavailable', 'course-prohibited', 'grant-level',
  'authorization-unavailable', 'audit-unavailable']);
const receipt = z.strictObject({ recorded: z.literal(true) });
export const autonomyContracts = {
  'autonomy.check': { input: z.strictObject({ assessmentId: AuditIdSchema, action: z.enum(['read', 'click', 'fill', 'select', 'submit', 'other']) }),
    output: z.strictObject({ decision: z.enum(['allowed', 'denied']), reason: ReasonSchema }), level: 0 },
  'autonomy.policy.set': { input: z.strictObject({ courseId: AuditIdSchema, status: PolicySchema.nullable() }), output: receipt, level: 0 },
  'autonomy.default.set': { input: z.strictObject({ courseId: AuditIdSchema, level: WorkLevelSchema }), output: receipt, level: 0 },
  'autonomy.override.set': { input: z.strictObject({ assessmentId: AuditIdSchema, level: WorkLevelSchema }), output: receipt, level: 0 },
  'autonomy.override.clear': { input: z.strictObject({ assessmentId: AuditIdSchema }), output: receipt, level: 0 },
  'autonomy.confirmation.set': { input: z.strictObject({ courseId: AuditIdSchema, confirmBeforeSubmit: z.boolean() }), output: receipt, level: 0 },
} as const;
export type AutonomyCommand = keyof typeof autonomyContracts;
type CheckInput = z.infer<typeof autonomyContracts['autonomy.check']['input']>;
type Decision = z.infer<typeof autonomyContracts['autonomy.check']['output']>;
type WorkLevel = z.infer<typeof WorkLevelSchema>;
type Policy = z.infer<typeof PolicySchema>;
type AuthorityReferences = Pick<AuditEvent, 'courseId' | 'assessmentId' | 'level' | 'policyRef' | 'grantRef'>;
type AutonomyRepository = Pick<Repository, 'loadCourse' | 'loadAssessment' | 'readAnnotations' | 'appendAnnotation' | 'readCourseAutonomy' | 'appendCourseAutonomy'>;

export function required(kind: unknown): 1 | 2 { return kind === 'quiz' || kind === 'ongoing' ? 1 : 2; }
export function cap(policy?: Policy): 0 | 2 { return policy === 'prohibited' ? 0 : 2; }
export function effective(defaultLevel: WorkLevel, override?: WorkLevel, policy?: Policy): WorkLevel {
  return Math.min(override ?? defaultLevel, cap(policy)) as WorkLevel;
}
/** New authority lives in delivery entities; old policy files and L0–L4 grants are never read. */
export class AssessmentAutonomy {
  constructor(private readonly store: AutonomyRepository, private readonly audit: { record(event: AuditEvent): Promise<void> }) {}
  private course(courseId: string): void {
    if (!this.store.loadCourse(courseId)) throw new CourseworkError('NOT_FOUND', 'Course not found.');
  }
  private target(assessmentId: string) {
    const target = this.store.loadAssessment(assessmentId);
    if (!target) throw new CourseworkError('NOT_FOUND', 'Assessment not found.');
    this.course(target.courseId);
    return target;
  }
  settings(courseId: string) {
    this.course(courseId);
    return this.store.readCourseAutonomy(courseId).at(-1) ?? { courseId, defaultLevel: 0 as const, confirmBeforeSubmit: true };
  }
  private ownerField(entity: 'course' | 'assessment', id: string, field: string) {
    return this.store.readAnnotations(entity, id).filter(row => row.origin === 'owner' && row.field === field).at(-1);
  }
  private policy(courseId: string) {
    // Policy prose is evidence, not an authority setting. Only owner enum records set the cap.
    const row = this.store.readAnnotations('course', courseId).filter(row => row.origin === 'owner' && row.field === 'aiPolicy'
      && (row.value === null || PolicySchema.safeParse(row.value).success)).at(-1);
    return { value: row && row.value !== null ? PolicySchema.parse(row.value) : undefined, ref: row ? hash(row) : undefined };
  }
  private kind(assessmentId: string, fallback: unknown) {
    const rows = this.store.readAnnotations('assessment', assessmentId).filter(row => row.field === 'kind');
    const row = rows.filter(row => row.origin === 'owner').at(-1) ?? rows.filter(row => row.origin === 'agent').at(-1);
    return row ? AssessmentSchema.shape.kind.parse(row.value ?? undefined) : fallback;
  }
  private authority(courseId: string, assessmentId?: string) {
    const settings = this.settings(courseId);
    const policy = this.policy(courseId);
    const override = assessmentId ? this.ownerField('assessment', assessmentId, 'autonomyLevel') : undefined;
    const value = override && override.value !== null ? WorkLevelSchema.parse(override.value) : undefined;
    const level = effective(WorkLevelSchema.parse(settings.defaultLevel), value, policy.value);
    const grantRef = value !== undefined ? hash(override!) : 'at' in settings ? hash(settings) : undefined;
    const refs: AuthorityReferences = { courseId, ...(assessmentId ? { assessmentId } : {}), level,
      ...(policy.ref ? { policyRef: policy.ref } : {}), ...(grantRef ? { grantRef } : {}) };
    return { level, policy: policy.value, refs };
  }
  references(name: AutonomyCommand, input: unknown): AuthorityReferences {
    const parsed = autonomyContracts[name].input.parse(input);
    if ('assessmentId' in parsed) {
      const target = this.target(parsed.assessmentId);
      return this.authority(target.courseId, target.id).refs;
    }
    return this.authority(parsed.courseId).refs;
  }
  /** Only the dispatcher supplies owner authority, after the transport's session gate. */
  async set(name: Exclude<AutonomyCommand, 'autonomy.check'>, input: unknown, context: TrustedContext) {
    if (!context.owner) throw new CourseworkError('INVALID_INPUT', 'Open coursework ui to perform this owner action.');
    await context.owner.assertOwner(name);
    const parsed = autonomyContracts[name].input.parse(input);
    const refs = this.references(name, parsed);
    const at = new Date().toISOString();
    if (name === 'autonomy.policy.set' || name.startsWith('autonomy.override.')) {
      const entity = name === 'autonomy.policy.set' ? 'course' : 'assessment';
      const value = 'status' in parsed ? parsed.status : 'level' in parsed ? parsed.level : null;
      this.store.appendAnnotation({ id: randomUUID(), entity, entityId: entity === 'course' ? refs.courseId! : refs.assessmentId!,
        field: entity === 'course' ? 'aiPolicy' : 'autonomyLevel', value, origin: 'owner', citations: [], at });
    } else {
      const previous = this.settings(refs.courseId!);
      this.store.appendCourseAutonomy({ courseId: refs.courseId!, defaultLevel: 'level' in parsed ? parsed.level : previous.defaultLevel,
        confirmBeforeSubmit: 'confirmBeforeSubmit' in parsed ? parsed.confirmBeforeSubmit : previous.confirmBeforeSubmit, at });
    }
    // Capture this mutation's version synchronously, before another owner call can write.
    context.setAuditReferences?.(this.references(name, parsed));
    return { recorded: true as const };
  }
  async check(input: CheckInput, runId: string = randomUUID()): Promise<Decision> {
    const { assessmentId, action } = autonomyContracts['autonomy.check'].input.parse(input);
    let reason: Decision['reason'] = 'allowed';
    let level: WorkLevel = 0;
    const refs: Pick<AuditEvent, 'courseId' | 'assessmentId' | 'policyRef' | 'grantRef'> = {};
    const target = (() => { try { return this.target(assessmentId); } catch { return undefined; } })();
    if (!target) reason = 'assessment-unavailable';
    else try {
      refs.courseId = target.courseId; refs.assessmentId = target.id;
      const authority = this.authority(target.courseId, target.id);
      Object.assign(refs, authority.refs);
      level = authority.level;
      if (action !== 'read') {
        if (authority.policy === 'prohibited') reason = 'course-prohibited';
        else if (level < required(this.kind(target.id, target.kind))) reason = 'grant-level';
      }
    } catch { reason = 'authorization-unavailable'; }
    const decision = reason === 'allowed' ? 'allowed' : 'denied';
    try { await this.audit.record({ ...refs, runId, command: 'autonomy.check', phase: decision === 'allowed' ? 'outcome' : 'denial',
      code: decision === 'allowed' ? 'OK' : 'INVALID_INPUT', level, decision, reason }); }
    catch { return { decision: 'denied', reason: 'audit-unavailable' }; }
    return { decision, reason };
  }
}
