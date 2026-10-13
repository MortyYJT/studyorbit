import { z } from 'zod';
import { retryable } from './errors.js';

export const assessmentRefSchema = z.string().regex(/^ed:[1-9]\d{0,15}:[1-9]\d{0,15}$/);
export const auditSchema = z.strictObject({ version: z.literal(1), operation: z.enum(['read', 'policy', 'grant', 'prerequisites', 'proposal', 'review']),
  phase: z.enum(['intent', 'outcome', 'denial']), at: z.iso.datetime(), runId: z.uuid(),
  assessmentRef: assessmentRefSchema.optional(), revision: z.uuid().optional(), policyRef: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  grantRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), code: z.enum(['OK', ...Object.keys(retryable) as (keyof typeof retryable)[]]),
  reviewStatus: z.enum(['approved', 'rejected', 'cancelled', 'timed-out']).optional(),
});
