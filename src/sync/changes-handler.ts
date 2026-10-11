import { z } from 'zod';
import { ChangeSchema, type Change } from '../domain/schemas.js';
import type { Repository } from '../store/repository.js';
import { ok, fail, type Envelope } from '../protocol/envelope.js';
import { CourseworkError } from '../protocol/errors.js';

export const ChangesInputSchema = z.strictObject({
  since: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(500).default(100),
});
export const ChangesOutputSchema = z.strictObject({
  changes: z.array(ChangeSchema), nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
/** Reusable handler; CLI and protocol registry wiring are deferred to their milestones. */
export async function changesHandler(repository: Pick<Repository, 'listChangesSince'>, input: unknown): Promise<Envelope> {
  try {
    const parsed = ChangesInputSchema.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'Invalid changes cursor or page size.');
    const { since, limit } = parsed.data;
    const changes: Change[] = [];
    let result = ok('changes', ChangesOutputSchema.parse({ changes, nextCursor: since }));
    for (const change of repository.listChangesSince(since, limit)) {
      const candidate = ok('changes', ChangesOutputSchema.parse({ changes: [...changes, change], nextCursor: change.seq }));
      if (!candidate.ok) {
        // A later oversized event waits at the next exclusive cursor. Never skip it.
        if (changes.length === 0) return candidate;
        break;
      }
      changes.push(change); result = candidate;
    }
    return result;
  } catch (error) {
    return error instanceof CourseworkError
      ? fail('changes', error.code, error.message, error.next)
      : fail('changes', 'INTERNAL', 'Unable to read changes.');
  }
}
