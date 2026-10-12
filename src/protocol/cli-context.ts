import type { TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';

/** Host placeholder until Issue I injects production ports. Never use synthetic fixtures here. */
export function unavailableCLIContext(): TrustedContext {
  const unavailable = async (): Promise<never> => { throw new CourseworkError('SOURCE_UNAVAILABLE', 'Production command services are not mounted.'); };
  return {
    repository: { read: unavailable }, services: { write: unavailable },
    authorization: { check: unavailable }, evidence: { check: unavailable },
    privacy: { protect: async (_command, data) => data },
    // No operational backend is selected by the transport. Q1 owns its existing journals.
    audit: { record: async () => {} }, runs: { record: async () => {} },
  };
}
