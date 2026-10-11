import { z } from 'zod';
import { CourseworkError } from '../protocol/errors.js';
import { edId } from './read/contracts.js';
export const localId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const date = z.iso.date().refine(value => new Date(value).toISOString().slice(0, 10) === value);
const base = { version: z.literal(1), course: edId };
export const policySchema = z.discriminatedUnion('status', [
  z.strictObject({ ...base, status: z.literal('allowed'), quote: z.string().trim().min(1), locator: z.string().trim().min(1), cap: z.number().int().min(2).max(4) }),
  z.strictObject({ ...base, status: z.literal('prohibited'), quote: z.string().trim().min(1), locator: z.string().trim().min(1), cap: z.literal(1) }),
  z.strictObject({ ...base, status: z.literal('owner-attested'), attestation: z.string().trim().min(1), date, cap: z.number().int().min(2).max(4) }),
]);
export const bindingSchema = z.strictObject({ assessmentId: localId, course: edId, lesson: edId, category: z.enum(['assignment', 'ongoing', 'exam', 'unknown']) });
export const grantSchema = z.strictObject({ version: z.literal(1), binding: bindingSchema, level: z.number().int().min(0).max(4), date });
export const prerequisiteSchema = z.strictObject({ version: z.literal(1), binding: bindingSchema, repositoryPrivate: z.literal(true), verifiedAt: z.iso.datetime({ offset: true }) });
export type Binding = z.infer<typeof bindingSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Grant = z.infer<typeof grantSchema>;
export function invalidAuthorization(): never { throw new CourseworkError('INVALID_INPUT', 'Record valid course policy and exact assessment authorization in an owner terminal.'); }
export function validatePolicy(input: unknown): Policy { const result = policySchema.safeParse(input); if (!result.success) return invalidAuthorization(); return result.data; }
export function validateGrant(input: unknown): Grant { const result = grantSchema.safeParse(input); if (!result.success) return invalidAuthorization(); return result.data; }
export function authorize(policy: unknown, grant: unknown, binding: unknown, level: 2 | 3): Grant {
  const p = validatePolicy(policy); const g = validateGrant(grant); const b = bindingSchema.safeParse(binding);
  if (!b.success || p.course !== b.data.course || JSON.stringify(g.binding) !== JSON.stringify(b.data)
    || ['exam', 'unknown'].includes(b.data.category) || g.level < level || g.level > p.cap || p.cap < level) return invalidAuthorization();
  return g;
}
export function verifyRealPrerequisites(input: unknown, policy: unknown, prerequisite: unknown): void {
  const t = z.strictObject({ course: edId, lesson: edId }).safeParse(input); if (!t.success) return invalidAuthorization();
  const target = t.data;
  const p = validatePolicy(policy); const r = prerequisiteSchema.safeParse(prerequisite);
  if (!r.success || p.status !== 'owner-attested' || p.date !== '2026-10-12' || p.course !== target.course
    || r.data.binding.course !== target.course || r.data.binding.lesson !== target.lesson
    || ['exam', 'unknown'].includes(r.data.binding.category)) invalidAuthorization();
}
