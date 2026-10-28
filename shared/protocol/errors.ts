export const retryable = Object.freeze({
  INVALID_INPUT: false,
  NOT_FOUND: false,
  CONFLICT: true,
  AUTH_EXPIRED: false,
  SOURCE_UNAVAILABLE: true,
  LOCKED: true,
  CITATION_MISMATCH: false,
  LIMIT_EXCEEDED: false,
  INTERNAL: false,
  UNCERTAIN: false,
} as const);

export type ErrorCode = keyof typeof retryable;

export class CourseworkError extends Error {
  readonly code: ErrorCode;
  readonly next?: string;

  constructor(code: ErrorCode, message: string, next?: string) {
    super(message);
    this.name = 'CourseworkError';
    this.code = code;
    // Authentication recovery always belongs to the user, regardless of caller hints.
    this.next = code === 'AUTH_EXPIRED' ? 'Ask the user to sign in again.' : next;
  }
}

/**
 * A refusal whose message our own code composed (fixed text, course keys and contract field paths, never request
 * prose), so the dispatcher may pass it to the agent: course reading needs the failing paths to retry (#170).
 */
export class AgentFacingError extends CourseworkError {}
