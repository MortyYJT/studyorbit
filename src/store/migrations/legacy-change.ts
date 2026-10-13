import { z } from 'zod';

const IdSchema = z.string().min(1);
const TimeSchema = z.iso.datetime({ offset: true });

// Frozen historical validation for migration 002; not part of the current domain.
export const ChangeSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(['created', 'updated', 'deleted']),
  entity: z.enum(['course', 'assessment', 'source_item', 'task']),
  entityId: IdSchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  at: TimeSchema,
}).superRefine((change, ctx) => {
  const needsBefore = change.kind !== 'created';
  const needsAfter = change.kind !== 'deleted';
  for (const [field, required] of [['before', needsBefore], ['after', needsAfter]] as const) {
    if ((change[field] !== undefined) !== required) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${change.kind} ${required ? 'requires' : 'forbids'} ${field}` });
    }
  }
});
