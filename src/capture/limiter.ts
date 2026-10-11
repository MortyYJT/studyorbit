import { CourseworkError } from '../protocol/errors.js';
export interface RequestClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface CaptureLimiter { readonly attempts: number; attempt<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> }
const realClock: RequestClock = { now: Date.now, sleep: (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException('Capture cancelled.', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
}) };
export class RequestLimiter implements CaptureLimiter {
  private count = 0;
  private ended?: number;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly clock: RequestClock = realClock) {}
  get attempts(): number { return this.count; }
  attempt<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const check = () => { if (signal?.aborted) throw new DOMException('Capture cancelled.', 'AbortError'); };
    const result = this.tail.then(async () => {
      check();
      if (this.count >= 300) throw new CourseworkError('LIMIT_EXCEEDED', 'Capture attempt limit reached.');
      while (this.ended !== undefined && this.clock.now() < this.ended + 1000) {
        await this.clock.sleep(this.ended + 1000 - this.clock.now(), signal); check();
      }
      check(); this.count++;
      try { return await operation(); }
      finally { this.ended = this.clock.now(); }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
