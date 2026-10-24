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
const PolicySchema = z.enum(['allowed', 'prohibited', 'owner-attested']);
export const ReasonSchema = z.enum(['allowed', 'assessment-unavailable', 'course-prohibited', 'grant-level',
  'authorization-unavailable', 'audit-unavailable']);
const receipt = z.strictObject({ recorded: z.literal(true) });
const KindSchema = AssessmentSchema.shape.kind.unwrap();
/** One assessment's authority as the owner UI shows it; exams carry no level (#126, #146). */
export const AutonomyAssessmentSchema = z.strictObject({ assessmentId: AuditIdSchema, kind: KindSchema.nullable(), applicable: z.boolean(),
  requiredLevel: z.union([z.literal(1), z.literal(2)]).nullable(), override: WorkLevelSchema.nullable(), effectiveLevel: WorkLevelSchema.nullable() });
export const AutonomyReadSchema = z.strictObject({ courseId: AuditIdSchema, policy: PolicySchema.nullable(),
  /** Who set the effective policy: the owner, or the agent's read of the course (#180); null when unknown. */
  policyOrigin: z.enum(['owner', 'agent']).nullable(), cap: z.union([z.literal(0), z.literal(2)]),
  defaultLevel: WorkLevelSchema, confirmBeforeSubmit: z.boolean(), assessments: z.array(AutonomyAssessmentSchema).max(500) });
export const autonomyContracts = {
  'autonomy.check': { input: z.strictObject({ assessmentId: AuditIdSchema, action: z.enum(['read', 'click', 'fill', 'select', 'submit', 'other']) }),
    output: z.strictObject({ decision: z.enum(['allowed', 'denied']), reason: ReasonSchema }), level: 0 },
  'autonomy.read': { input: z.strictObject({ courseId: AuditIdSchema }), output: AutonomyReadSchema, level: 0 },
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
type AutonomyRepository = Pick<Repository, 'loadCourse' | 'loadAssessment' | 'readAnnotations' | 'appendAnnotation' | 'readCourseAutonomy' | 'appendCourseAutonomy'>
  & Partial<Pick<CurrentStateReader, 'query'>>;
type OwnerCommand = Exclude<AutonomyCommand, 'autonomy.check' | 'autonomy.read'>;

export function required(kind: unknown): 1 | 2 { return kind === 'quiz' || kind === 'ongoing' ? 1 : 2; }
export function cap(policy?: Policy): 0 | 2 { return policy === 'prohibited' ? 0 : 2; }
export function effective(defaultLevel: WorkLevel, override?: WorkLevel, policy?: Policy): WorkLevel {
  return Math.min(override ?? defaultLevel, cap(policy)) as WorkLevel;
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
    return this.store.readCourseAutonomy(courseId).at(-1) ?? { courseId, defaultLevel: 0 as const, confirmBeforeSubmit: true };
  }
  private ownerField(entity: 'course' | 'assessment', id: string, field: string) {
    return this.store.readAnnotations(entity, id).filter(row => row.origin === 'owner' && row.field === field).at(-1);
  }
  /** Effective policy: the owner's recorded value, else the agent-read Course.aiPolicy, else unknown (#180, #125). */
  private policy(courseId: string): { value?: Policy; origin?: 'owner' | 'agent'; ref?: string } {
    // Policy prose is evidence, not an authority setting. Only owner enum records set the cap; null clears them.
    const row = this.store.readAnnotations('course', courseId).filter(row => row.origin === 'owner' && row.field === 'aiPolicy'
      && (row.value === null || PolicySchema.safeParse(row.value).success)).at(-1);
    if (row && row.value !== null) return { value: PolicySchema.parse(row.value), origin: 'owner', ref: hash(row) };
    const course = this.store.loadCourse(courseId);
    const read = PolicySchema.safeParse(course?.aiPolicy);
    if (read.success) return { value: read.data, origin: 'agent', ref: hash({ courseId, aiPolicy: read.data, readState: course?.readState?.aiPolicy ?? null }) };
    return { ref: row ? hash(row) : undefined };
  }
  private kind(assessmentId: string, fallback: unknown) {
    if (this.resolveKind) return this.resolveKind(assessmentId) ?? undefined;
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
    return { level, policy: policy.value, policyOrigin: policy.origin, refs };
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
  async set(name: OwnerCommand, input: unknown, context: TrustedContext) {
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
  /** L0 read over the same authority path as check(); it records nothing. */
  read(input: unknown): z.infer<typeof AutonomyReadSchema> {
    const { courseId } = autonomyContracts['autonomy.read'].input.parse(input);
    if (!this.store.query) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Assessment listing is unavailable.');
    const course = this.authority(courseId);
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
        assessments.push({ assessmentId: assessment.id, kind, applicable, requiredLevel: applicable ? required(kind ?? undefined) : null,
          override: override && override.value !== null ? WorkLevelSchema.parse(override.value) : null,
          effectiveLevel: applicable ? this.authority(courseId, assessment.id).level : null });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { courseId, policy: course.policy ?? null, policyOrigin: course.policyOrigin ?? null, cap: cap(course.policy), defaultLevel: WorkLevelSchema.parse(settings.defaultLevel),
      // Same truthiness the browser submit path applies to this setting.
      confirmBeforeSubmit: Boolean(settings.confirmBeforeSubmit), assessments };
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
