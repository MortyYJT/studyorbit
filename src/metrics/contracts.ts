import { z } from 'zod';
import { AssessmentSchema } from '../domain/schemas.js';
const count = z.number().int().nonnegative();
const number = z.number().nonnegative();
const unavailable = <R extends string>(reason: R) => z.strictObject({ available: z.literal(false), reason: z.literal(reason), count: z.literal(0) });
const sync = z.union([unavailable('no_runs'), z.strictObject({ available: z.literal(true), count, successes: count,
  successRate: number.max(1), medianDurationMs: number, maxDurationMs: number, durationBasis: z.literal('sync_run') })]);
const cost = z.union([
  z.strictObject({ available: z.literal(false), reason: z.literal('no_reported_costs'), count: z.literal(0), unknownCount: count }),
  z.strictObject({ available: z.literal(true), totalUsd: number, count, unknownCount: count }),
]);
const kind = z.union([AssessmentSchema.shape.kind.unwrap(), z.literal('unknown')]);
const totals = { steps: count, turns: count, cost };
export const metricsContracts = {
  'metrics.read': {
    // Half-open instants: runs use startedAt, verdicts/logs use at. Estimates are effective before to.
    // cursor is a zero-based conversation offset; omit it for the first page (default/max 25).
    input: z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
      cursor: count.safe().optional(), limit: z.number().int().min(1).max(25).optional() })
      .refine(value => Date.parse(value.from) < Date.parse(value.to), 'from must precede to'),
    output: z.strictObject({
      from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
      sync: z.strictObject({ canvas: sync, ed: sync }),
      accuracy: z.union([unavailable('no_labels'), z.strictObject({ available: z.literal(true), count, correct: count, incorrect: count, value: number.max(1) })]),
      estimates: z.union([unavailable('no_items'), z.strictObject({ available: z.literal(true), count, medianRatio: number, meanRatio: number })]),
      agent: z.union([unavailable('no_conversations'), z.strictObject({ available: z.literal(true), count, cost,
        conversations: z.array(z.strictObject({ conversationId: z.string().min(1).max(256), kind, ...totals })),
        nextCursor: count.safe().optional(),
        byKind: z.array(z.strictObject({ kind, count, ...totals })),
      })]),
    }), level: 0,
  },
} as const;
export type MetricsInput = z.infer<typeof metricsContracts['metrics.read']['input']>;
export type MetricsOutput = z.infer<typeof metricsContracts['metrics.read']['output']>;
