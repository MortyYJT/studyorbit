import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LevelSchema } from './contracts.js';
import type { AuthorizationStore } from './authorization.js';
import type { AuditEvent } from './context.js';
// Input syntax only; audit references must come from trusted target resolution.
export const AuditIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/);
export const ReasonSchema = z.enum(['allowed', 'assessment-unavailable', 'policy-missing', 'course-prohibited', 'exam',
  'kind-unknown', 'grant-missing', 'grant-mismatch', 'grant-revoked', 'grant-level', 'course-cap', 'authorization-unavailable', 'audit-unavailable']);
export const OutcomeSchema = z.enum(['success', 'failure', 'uncertain', 'violation']);
export const ConfirmationSchema = z.enum(['owner-chat', 'owner-ui', 'owner-terminal']);
export const autonomyContracts = {
  'autonomy.check': { input: z.strictObject({ assessmentId: AuditIdSchema, level: LevelSchema }),
    output: z.strictObject({ decision: z.enum(['allowed', 'denied']), reason: ReasonSchema }), level: 0 },
  'audit.record': { input: z.strictObject({ assessmentId: AuditIdSchema, level: LevelSchema, action: z.enum(['fill', 'submit', 'other']),
    outcome: OutcomeSchema, confirmation: ConfirmationSchema.optional() }),
    output: z.strictObject({ recorded: z.literal(true), outcome: OutcomeSchema }), level: 0 },
} as const;
type CheckInput = z.infer<typeof autonomyContracts['autonomy.check']['input']>;
type RecordInput = z.infer<typeof autonomyContracts['audit.record']['input']>;
type Decision = z.infer<typeof autonomyContracts['autonomy.check']['output']>;
export class AssessmentAutonomy {
  constructor(private readonly store: AuthorizationStore, private readonly audit: { record(event: AuditEvent): Promise<void> }) {}
  async check(input: CheckInput, runId: string = randomUUID()): Promise<Decision> {
    const { assessmentId, level } = autonomyContracts['autonomy.check'].input.parse(input);
    let reason: Decision['reason'] = 'allowed'; let refs: Pick<AuditEvent, 'courseId' | 'assessmentId' | 'policyRef' | 'grantRef'> = {};
    // Resolve the target first and keep its trusted references even if a permission read fails.
    const target = await this.store.target(assessmentId).catch(() => undefined);
    if (!target) reason = 'assessment-unavailable';
    else try {
      refs = { courseId: target.courseId, assessmentId: target.assessmentId };
      const policy = await this.store.policy(target.courseId); const grant = await this.store.grant(target.assessmentId);
      if (policy) refs.policyRef = policy.ref;
      if (grant) refs.grantRef = grant.ref;
      if (level > 1) {
        if (!policy) reason = 'policy-missing';
        else if (policy.record.courseId !== target.courseId) reason = 'authorization-unavailable';
        else if (policy.record.status === 'prohibited') reason = 'course-prohibited';
        else if (target.category === 'exam') reason = 'exam';
        else if (target.category === 'unknown') reason = 'kind-unknown';
        else if (!grant) reason = 'grant-missing';
        else if (grant.record.assessmentId !== target.assessmentId || grant.record.courseId !== target.courseId || grant.record.category !== target.category) reason = 'grant-mismatch';
        else if (grant.record.level === 0) reason = 'grant-revoked';
        else if (policy.record.cap < level || grant.record.level > policy.record.cap) reason = 'course-cap';
        else if (grant.record.level < level) reason = 'grant-level';
      }
    } catch { reason = 'authorization-unavailable'; }
    const decision = reason === 'allowed' ? 'allowed' : 'denied';
    try { await this.audit.record({ ...refs, runId, command: 'autonomy.check', phase: decision === 'allowed' ? 'outcome' : 'denial',
      code: decision === 'allowed' ? 'OK' : 'INVALID_INPUT', level, decision, reason }); }
    catch { return { decision: 'denied', reason: 'audit-unavailable' }; }
    return { decision, reason };
  }
  async record(input: RecordInput, runId: string = randomUUID()) {
    const parsed = autonomyContracts['audit.record'].input.parse(input);
    // Recording follows an actual browser action. Unreadable permission records must not
    // erase that action; retain only independently resolved, safe references.
    const refs: Pick<AuditEvent, 'courseId' | 'assessmentId' | 'policyRef' | 'grantRef'> = {};
    const target = await this.store.target(parsed.assessmentId).catch(() => undefined);
    if (target) {
      refs.assessmentId = target.assessmentId;
      refs.courseId = target.courseId;
      const policy = await this.store.policy(target.courseId).catch(() => undefined);
      const grant = await this.store.grant(target.assessmentId).catch(() => undefined);
      if (policy) refs.policyRef = policy.ref;
      if (grant) refs.grantRef = grant.ref;
    }
    // Unresolved request references are omitted, and cannot report a successful action.
    const outcome = parsed.level === 4 && parsed.action === 'submit' && !parsed.confirmation ? 'violation'
      : !target ? 'failure' : parsed.outcome;
    await this.audit.record({ ...refs, runId, command: 'audit.record', phase: 'outcome', code: outcome === 'success' ? 'OK' : 'INVALID_INPUT',
      level: parsed.level, action: parsed.action, outcome, ...(parsed.confirmation ? { confirmation: parsed.confirmation } : {}) });
    return { recorded: true as const, outcome };
  }
}
