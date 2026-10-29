export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
export type ManualClock = Clock & { advance(ms: number): void; pending(): number };
export type TaskFailure = { ok: false; retryable?: boolean; retryAfterMs?: number | null; error?: string; [key: string]: unknown };
export type TaskResult<T> = { ok: true; value: T; [key: string]: unknown } | TaskFailure;
export type LimiterResult<T> = TaskResult<T> & { attempts: number; waitedMs: number; gaveUp?: 'RETRY_AFTER_TOO_LONG' | 'WAIT_BUDGET' };
export type RetryBudget = { waitedMs: number };
export type LimiterOptions = {
  concurrency?: number; minIntervalMs?: number; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number;
  maxRetryAfterMs?: number; maxTotalWaitMs?: number; jitter?: number; clock?: Clock; random?: () => number;
};
export type Limiter = {
  run<T>(task: (attempt: number) => Promise<TaskResult<T>>, options?: { signal?: AbortSignal; budget?: RetryBudget }): Promise<LimiterResult<T>>;
  active(): number;
  queued(): number;
};
export const systemClock: Clock;
export const RETRY_DEFAULTS: Readonly<{ maxAttempts: number; baseDelayMs: number; maxDelayMs: number; maxRetryAfterMs: number; maxTotalWaitMs: number; jitter: number }>;
export function manualClock(start?: number, options?: { instant?: boolean }): ManualClock;
export function createLimiter(options?: LimiterOptions): Limiter;
