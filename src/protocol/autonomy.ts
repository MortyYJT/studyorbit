import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repository } from '../store/repository.js';
import type { CurrentStateReader } from '../store/queries.js';
import { AssessmentSchema } from '../domain/schemas.js';
import { hash } from '../citations/exact.js';
import type { AuditEvent, TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';

// Input syntax only; audit references come from trusted target resolution.
export const AuditIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/);
export const WorkLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const PolicySchema = z.enum(['allowed', 'prohibited', 'owner-attested']);
export const EffectivePolicySchema = z.strictObject({
  value: z.union([PolicySchema, z.literal('unknown')]),
  origin: z.enum(['owner', 'agent', 'none']),
  level: z.enum(['assessment', 'course', 'none']),
});
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;
const policyFields = { policy: PolicySchema.nullable(), policyOrigin: z.enum(['owner', 'agent']).nullable(),
  policyLevel: z.enum(['assessment', 'course']).nullable(), effectivePolicy: EffectivePolicySchema };
export const ReasonSchema = z.enum(['allowed', 'assessment-unavailable', 'assessment-prohibited', 'course-prohibited',
  'grant-level', 'authorization-unavailable', 'audit-unavailable']);
const receipt = z.strictObject({ recorded: z.literal(true) });
const KindSchema = AssessmentSchema.shape.kind.unwrap();
/** One assessment's authority as the owner UI shows it; exams carry no level (#126, #146). */
export const AutonomyAssessmentSchema = z.strictObject({ assessmentId: AuditIdSchema, kind: KindSchema.nullable(), applicable: z.boolean(),
  requiredLevel: z.union([z.literal(1), z.literal(2)]).nullable(), override: WorkLevelSchema.nullable(), effectiveLevel: WorkLevelSchema.nullable(),
  ...policyFields });
export const AutonomyReadSchema = z.strictObject({ courseId: AuditIdSchema, ...policyFields,
  cap: z.union([z.literal(0), z.literal(2)]), defaultLevel: WorkLevelSchema, assessments: z.array(AutonomyAssessmentSchema).max(500) });
const PolicySetSchema = z.union([
  z.strictObject({ courseId: AuditIdSchema, assessmentId: AuditIdSchema.optional(), value: PolicySchema.nullable() }),
  z.strictObject({ courseId: AuditIdSchema, assessmentId: AuditIdSchema.optional(), status: PolicySchema.nullable() }),
]);
export type PolicySetInput = z.infer<typeof PolicySetSchema>;
export const autonomyContracts = {
  'autonomy.check': { input: z.strictObject({ assessmentId: AuditIdSchema, action: z.enum(['read', 'click', 'fill', 'select', 'submit', 'other']) }),
    output: z.strictObject({ decision: z.enum(['allowed', 'denied']), reason: ReasonSchema }), level: 0 },
  'autonomy.read': { input: z.strictObject({ courseId: AuditIdSchema }), output: AutonomyReadSchema, level: 0 },
  'autonomy.policy.set': { input: z.strictObject({ courseId: AuditIdSchema, assessmentId: AuditIdSchema.optional(), status: PolicySchema.nullable() }), output: receipt, level: 0 },
  'autonomy.default.set': { input: z.strictObject({ courseId: AuditIdSchema, level: WorkLevelSchema }), output: receipt, level: 0 },
  'autonomy.override.set': { input: z.strictObject({ assessmentId: AuditIdSchema, level: WorkLevelSchema }), output: receipt, level: 0 },
  'autonomy.override.clear': { input: z.strictObject({ assessmentId: AuditIdSchema }), output: receipt, level: 0 },
} as const;
/** Server dispatch also accepts the value/status union for `autonomy.policy.set`. */
export const autonomyCommandContracts = {
  ...autonomyContracts,
  'autonomy.policy.set': { input: PolicySetSchema, output: receipt, level: 0 },
} as const;
export type AutonomyCommand = keyof typeof autonomyCommandContracts;
type CheckInput = z.infer<typeof autonomyContracts['autonomy.check']['input']>;
type Decision = z.infer<typeof autonomyContracts['autonomy.check']['output']>;
type WorkLevel = z.infer<typeof WorkLevelSchema>;
type Policy = z.infer<typeof PolicySchema>;
type AuthorityReferences = Pick<AuditEvent, 'courseId' | 'assessmentId' | 'level' | 'policyRef' | 'grantRef'>;
type AutonomyRepository = Pick<Repository, 'loadCourse' | 'loadAssessment' | 'readAnnotations' | 'appendAnnotation' | 'readCourseAutonomy' | 'appendCourseAutonomy'>
  & Partial<Pick<CurrentStateReader, 'query'>>;
type PolicyStore = Pick<Repository, 'loadCourse' | 'loadAssessment' | 'readAnnotations'>;
type OwnerCommand = Exclude<AutonomyCommand, 'autonomy.check' | 'autonomy.read'>;
type Resolution = EffectivePolicy & { ref?: string };
type Source = { value?: Policy; origin: 'owner' | 'agent'; level: 'assessment' | 'course'; ref?: string };

export function required(kind: unknown): 1 | 2 { return kind === 'quiz' || kind === 'participation' || kind === 'ongoing' ? 1 : 2; }
export function cap(policy?: Policy): 0 | 2 { return policy === 'prohibited' ? 0 : 2; }
export function effective(defaultLevel: WorkLevel, override?: WorkLevel, policy?: Policy): WorkLevel {
  return Math.min(override ?? defaultLevel, cap(policy)) as WorkLevel;
}
function ownerValue(store: PolicyStore, entity: 'course' | 'assessment', id: string) {
  const row = store.readAnnotations(entity, id).filter(row => row.origin === 'owner' && row.field === 'aiPolicy'
    && (row.value === null || PolicySchema.safeParse(row.value).success)).at(-1);
  const value = row && row.value !== null && PolicySchema.safeParse(row.value).success ? PolicySchema.parse(row.value) : undefined;
  return { row, value };
}
function agentValue(value: unknown): Policy | undefined {
  const parsed = PolicySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/** #197 resolution order shared by autonomy, annotation reads and list projections. */
export function storedPolicy(store: PolicyStore, courseId: string, assessmentId?: string): Resolution {
  const course = store.loadCourse(courseId);
  const courseRow = ownerValue(store, 'course', courseId);
  const agentCourse = agentValue(course?.aiPolicy);
  const assessment = assessmentId ? store.loadAssessment(assessmentId) : undefined;
  const assessmentRow = assessmentId ? ownerValue(store, 'assessment', assessmentId) : undefined;
  // The owner's value on this assessment is final; a null row only clears the owner's level.
  if (assessmentId && assessmentRow?.value !== undefined) {
    return { value: assessmentRow.value, origin: 'owner', level: 'assessment', ...(assessmentRow.row ? { ref: hash(assessmentRow.row) } : {}) };
  }
  const sources: Source[] = [];
  if (assessmentId) {
    const value = agentValue(assessment?.aiPolicy);
    if (value !== undefined) sources.push({ value, origin: 'agent', level: 'assessment',
      ref: hash({ assessmentId, aiPolicy: value, readState: assessment?.readState?.aiPolicy ?? null }) });
  }
  // At one level a non-prohibited owner value is preferred to the agent-read value, but both stay in play so a
  // prohibited read at either layer still wins; a null owner row only clears the owner's value.
  if (courseRow?.value !== undefined) sources.push({ value: courseRow.value, origin: 'owner', level: 'course', ...(courseRow.row ? { ref: hash(courseRow.row) } : {}) });
  if (agentCourse !== undefined) sources.push({ value: agentCourse, origin: 'agent', level: 'course',
    ref: hash({ courseId, aiPolicy: agentCourse, readState: course?.readState?.aiPolicy ?? null }) });
  const prohibited = sources.find(source => source.value === 'prohibited');
  const chosen = prohibited ?? sources.find(source => source.value !== undefined);
  if (chosen?.value !== undefined) return { value: chosen.value, origin: chosen.origin, level: chosen.level, ...(chosen.ref ? { ref: chosen.ref } : {}) };
  return { value: 'unknown', origin: 'none', level: 'none' };
}
function policySetValue(input: PolicySetInput): Policy | null {
  return 'value' in input ? input.value : input.status;
}
/** New authority lives in delivery entities; old policy files and L0–L4 grants are never read. */
export class AssessmentAutonomy {
  constructor(private readonly store: AutonomyRepository, private readonly audit: { record(event: AuditEvent): Promise<void> },
    private readonly resolveKind?: (id: string) => unknown) {}
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
    return this.store.readCourseAutonomy(courseId).at(-1) ?? { courseId, defaultLevel: 0 as const };
  }
  private ownerField(entity: 'course' | 'assessment', id: string, field: string) {
    return this.store.readAnnotations(entity, id).filter(row => row.origin === 'owner' && row.field === field).at(-1);
  }
  /** #197 effective policy for a course, or for one of its assessments when an id is given. */
  policy(courseId: string, assessmentId?: string): EffectivePolicy {
    const { value, origin, level } = storedPolicy(this.store, courseId, assessmentId);
    return { value, origin, level };
  }
  private resolution(courseId: string, assessmentId?: string): Resolution {
    if (assessmentId) this.target(assessmentId);
    return storedPolicy(this.store, courseId, assessmentId);
  }
  private kind(assessmentId: string, fallback: unknown) {
    if (this.resolveKind) return this.resolveKind(assessmentId) ?? undefined;
    const rows = this.store.readAnnotations('assessment', assessmentId).filter(row => row.field === 'kind');
    const row = rows.filter(row => row.origin === 'owner').at(-1) ?? rows.filter(row => row.origin === 'agent').at(-1);
    return row ? AssessmentSchema.shape.kind.parse(row.value ?? undefined) : fallback;
  }
  private authority(courseId: string, assessmentId?: string) {
    const settings = this.settings(courseId);
    const policy = this.resolution(courseId, assessmentId);
    const override = assessmentId ? this.ownerField('assessment', assessmentId, 'autonomyLevel') : undefined;
    const value = override && override.value !== null ? WorkLevelSchema.parse(override.value) : undefined;
    const level = effective(WorkLevelSchema.parse(settings.defaultLevel), value, policy.value === 'unknown' ? undefined : policy.value);
    const grantRef = value !== undefined ? hash(override!) : 'at' in settings ? hash(settings) : undefined;
    const refs: AuthorityReferences = { courseId, ...(assessmentId ? { assessmentId } : {}), level,
      ...(policy.ref ? { policyRef: policy.ref } : {}), ...(grantRef ? { grantRef } : {}) };
    return { level, policy, refs };
  }
  references(name: AutonomyCommand, input: unknown): AuthorityReferences {
    const parsed = autonomyCommandContracts[name].input.parse(input);
    if ('assessmentId' in parsed && parsed.assessmentId) {
      const target = this.target(parsed.assessmentId);
      if ('courseId' in parsed && parsed.courseId !== target.courseId) throw new CourseworkError('NOT_FOUND', 'Assessment not found.');
      return this.authority(target.courseId, target.id).refs;
    }
    if (!('courseId' in parsed)) throw new CourseworkError('INVALID_INPUT', 'A course is required.');
    return this.authority(parsed.courseId).refs;
  }
  /** Only the dispatcher supplies owner authority, after the transport's session gate. */
  async set(name: OwnerCommand, input: unknown, context: TrustedContext) {
    if (!context.owner) throw new CourseworkError('INVALID_INPUT', 'Open coursework ui to perform this owner action.');
    await context.owner.assertOwner(name);
    const parsed = autonomyCommandContracts[name].input.parse(input);
    const refs = this.references(name, parsed);
    const at = new Date().toISOString();
    if (name === 'autonomy.policy.set') {
      const assessmentId = 'assessmentId' in parsed ? parsed.assessmentId : undefined;
      const entity = assessmentId ? 'assessment' : 'course';
      this.store.appendAnnotation({ id: randomUUID(), entity, entityId: assessmentId ?? refs.courseId!,
        field: 'aiPolicy', value: policySetValue(parsed as PolicySetInput), origin: 'owner', citations: [], at });
    } else if (name.startsWith('autonomy.override.')) {
      const override = parsed as z.infer<typeof autonomyContracts['autonomy.override.set']['input']>;
      this.store.appendAnnotation({ id: randomUUID(), entity: 'assessment', entityId: override.assessmentId,
        field: 'autonomyLevel', value: 'level' in parsed ? parsed.level : null, origin: 'owner', citations: [], at });
    } else {
      const previous = this.settings(refs.courseId!);
      // `confirmBeforeSubmit` is historical (no submit-confirmation flow); the schema default fills it.
      this.store.appendCourseAutonomy({ courseId: refs.courseId!, defaultLevel: 'level' in parsed ? parsed.level : previous.defaultLevel, at });
    }
    // Capture this mutation's version synchronously, before another owner call can write.
    context.setAuditReferences?.(this.references(name, parsed));
    return { recorded: true as const };
  }
  /** L0 read over the same authority path as check(); it records nothing. */
  read(input: unknown): z.infer<typeof AutonomyReadSchema> {
    const { courseId } = autonomyCommandContracts['autonomy.read'].input.parse(input);
    if (!this.store.query) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Assessment listing is unavailable.');
    const course = this.resolution(courseId);
    const settings = this.settings(courseId);
    const assessments: z.infer<typeof AutonomyAssessmentSchema>[] = [];
    let cursor: string | undefined;
    do {
      const page = this.store.query('assessments', { courseId, limit: 500, cursor });
      for (const assessment of page.items) {
        if (assessments.length === 500) throw new CourseworkError('LIMIT_EXCEEDED', 'The course has too many assessments to read at once.');
        const parsedKind = KindSchema.safeParse(this.kind(assessment.id, assessment.kind));
        const kind = parsedKind.success ? parsedKind.data : null;
        const override = this.ownerField('assessment', assessment.id, 'autonomyLevel');
        const applicable = kind !== 'exam';
        const policy = this.resolution(courseId, assessment.id);
        const overrideLevel = override && override.value !== null ? WorkLevelSchema.parse(override.value) : undefined;
        assessments.push({ assessmentId: assessment.id, kind, applicable, requiredLevel: applicable ? required(kind ?? undefined) : null,
          override: overrideLevel ?? null,
          effectiveLevel: applicable ? effective(WorkLevelSchema.parse(settings.defaultLevel), overrideLevel, policy.value === 'unknown' ? undefined : policy.value) : null,
          policy: policy.value === 'unknown' ? null : policy.value, policyOrigin: policy.origin === 'none' ? null : policy.origin,
          policyLevel: policy.level === 'none' ? null : policy.level,
          effectivePolicy: { value: policy.value, origin: policy.origin, level: policy.level } });
      }
      cursor = page.nextCursor;
    } while (cursor);
    const courseValue = course.value === 'unknown' ? undefined : course.value;
    return { courseId, policy: courseValue ?? null, policyOrigin: course.origin === 'none' ? null : course.origin,
      policyLevel: course.level === 'none' ? null : course.level,
      effectivePolicy: { value: course.value, origin: course.origin, level: course.level },
      cap: cap(courseValue), defaultLevel: WorkLevelSchema.parse(settings.defaultLevel), assessments };
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
        if (authority.policy.value === 'prohibited') {
          // A course ban takes precedence; an item-only ban adds the assessment reason (#197, #214).
          reason = this.resolution(target.courseId).value === 'prohibited' ? 'course-prohibited' : 'assessment-prohibited';
        } else if (level < required(this.kind(target.id, target.kind))) reason = 'grant-level';
      }
    } catch { reason = 'authorization-unavailable'; }
    const decision = reason === 'allowed' ? 'allowed' : 'denied';
    try { await this.audit.record({ ...refs, runId, command: 'autonomy.check', phase: decision === 'allowed' ? 'outcome' : 'denial',
      code: decision === 'allowed' ? 'OK' : 'INVALID_INPUT', level, decision, reason }); }
    catch { return { decision: 'denied', reason: 'audit-unavailable' }; }
    return { decision, reason };
  }
}
