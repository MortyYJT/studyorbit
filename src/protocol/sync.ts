import { z } from 'zod';
import { RunSchema, CitationSchema } from '../domain/schemas.js';
import type { SyncResult } from '../sync/service.js';
const status = z.enum(['OK', 'PARTIAL', 'AUTH_EXPIRED', 'LIMIT_EXCEEDED']);
const counts = { requests: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), failures: z.number().int().nonnegative() };
const provider = z.object({ status, ...counts });
const last = z.object({ id: z.string(), at: z.iso.datetime({ offset: true }), status, ...counts });
const state = z.object({ lastRun: last.optional(), lastSuccess: last.optional() });
export const syncContracts = {
  'sync.run': { input: z.strictObject({ course: z.string().regex(/^[A-Z]{4}\d{5}$/).optional() }),
    output: z.object({ run: RunSchema, providers: z.object({ canvas: provider, ed: provider }), ambiguities: z.array(z.string()), differences: z.array(z.object({ entityId: z.string(), field: z.string() })), citations: z.array(CitationSchema).max(40), details: z.object({ citations: z.number().int().nonnegative(), ambiguities: z.number().int().nonnegative(), differences: z.number().int().nonnegative() }).optional() }), level: 0 as const },
  'sync.status': { input: z.strictObject({}), output: z.object({ running: z.boolean(), canvas: state, ed: state }), level: 0 as const },
};
export interface SyncCommands { run(input: { course?: string }): Promise<SyncResult>; status(): z.output<typeof syncContracts['sync.status']['output']> }
