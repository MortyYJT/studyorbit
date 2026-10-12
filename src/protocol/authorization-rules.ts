import { CourseworkError } from './errors.js';
/** Validated records only; both canonical and Q1 facades use this decision rule. */
export interface AuthorizationTarget { courseId: string; assessmentId: string; category: 'assignment' | 'ongoing' | 'exam' | 'unknown' }
export interface AuthorizationPolicy { courseId: string; status: 'allowed' | 'prohibited' | 'owner-attested'; cap: number }
export interface AuthorizationGrant extends AuthorizationTarget { level: number }
export function denyAuthorization(): never {
  throw new CourseworkError('INVALID_INPUT', 'Record valid course policy and exact assessment authorization in an owner terminal.');
}
export function enforceAuthorization(level: number, target?: AuthorizationTarget, policy?: AuthorizationPolicy, grant?: AuthorizationGrant): void {
  if (!Number.isInteger(level) || level < 0 || level > 4) denyAuthorization();
  if (level <= 1) return;
  if (!target || !policy || !grant || policy.courseId !== target.courseId || grant.courseId !== target.courseId
    || grant.assessmentId !== target.assessmentId || grant.category !== target.category
    || ['exam', 'unknown'].includes(target.category) || policy.status === 'prohibited'
    || grant.level < level || grant.level > policy.cap || policy.cap < level) denyAuthorization();
}
