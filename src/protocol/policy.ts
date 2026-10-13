import { z } from 'zod';
import { CourseworkError } from './errors.js';
import { enforceAuthorization } from './authorization-rules.js';
export const edId = z.string().regex(/^[1-9]\d{0,15}$/);
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
export type Binding = z.infer<typeof bindingSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Grant = z.infer<typeof grantSchema>;
export function invalidAuthorization(): never { throw new CourseworkError('INVALID_INPUT', 'Record valid course policy and exact assessment authorization in an owner terminal.'); }
export function validatePolicy(input: unknown): Policy { const result = policySchema.safeParse(input); if (!result.success) return invalidAuthorization(); return result.data; }
export function validateGrant(input: unknown): Grant { const result = grantSchema.safeParse(input); if (!result.success) return invalidAuthorization(); return result.data; }
export function authorize(policy: unknown, grant: unknown, binding: unknown, level: 2 | 3): Grant {
  const p = validatePolicy(policy); const g = validateGrant(grant); const b = bindingSchema.safeParse(binding);
  if (!b.success || JSON.stringify(g.binding) !== JSON.stringify(b.data)) return invalidAuthorization();
  enforceAuthorization(level, { courseId: b.data.course, assessmentId: b.data.assessmentId, category: b.data.category },
    { ...p, courseId: p.course }, { ...g, courseId: g.binding.course, assessmentId: g.binding.assessmentId, category: g.binding.category });
  return g;
}
