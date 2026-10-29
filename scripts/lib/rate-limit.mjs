// Per-platform rate limiting and bounded retry for the staged sync (design §9, decision #348). One limiter per
// platform: collectors run one at a time with a minimum interval between starts, model providers at most four at a
// time. A task returns `{ ok: true, value }` or `{ ok: false, retryable, retryAfterMs?, error, ... }`; only retryable
// failures are attempted again, at most `maxAttempts` times in total. The clock and random source are injected so
// tests never wait in real time.

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** Real time: `sleep` is a timer that rejects with an AbortError as soon as `signal` aborts. */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      const onAbort = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
});

/**
 * A clock for tests: time moves only through `advance(ms)`, which resolves every sleep that has become due.
 * `instant: true` makes every sleep advance the clock by itself and resolve at once (sequential virtual time).
 */
export function manualClock(start = 0, { instant = false } = {}) {
  let now = start;
  let timers = [];
  const fire = () => {
    const due = timers.filter(timer => timer.at <= now).sort((a, b) => a.at - b.at);
    timers = timers.filter(timer => timer.at > now);
    for (const timer of due) timer.resolve();
  };
  return {
    now: () => now,
    advance(ms) { now += ms; fire(); },
    pending: () => timers.length,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        if (instant) { now += Math.max(0, ms); resolve(); return; }
        const timer = {
          at: now + Math.max(0, ms),
          resolve: () => { signal?.removeEventListener('abort', onAbort); resolve(); },
        };
        const onAbort = () => { timers = timers.filter(item => item !== timer); reject(abortError()); };
        signal?.addEventListener('abort', onAbort, { once: true });
        timers.push(timer);
        if (ms <= 0) fire();
      });
    },
  };
}

export const RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 30_000, maxRetryAfterMs: 60_000, maxTotalWaitMs: 120_000, jitter: 0.2,
});

/**
 * Creates a limiter. `run(task, { signal, budget })` waits for a free slot and the minimum interval, then calls
 * `task(attempt)` (attempt counts from 1). A retryable failure is retried after
 * `max(retryAfterMs, min(baseDelayMs × 4^(n−2) × (1 ± jitter), maxDelayMs))`; a `retryAfterMs` above
 * `maxRetryAfterMs` is not waited for (`gaveUp: 'RETRY_AFTER_TOO_LONG'`), and the waits charged to `budget` (shared by
 * the calls of one stage) never exceed `maxTotalWaitMs` (`gaveUp: 'WAIT_BUDGET'`). The slot is held during backoff.
 * Resolves with the last task result plus `attempts` and `waitedMs`; rejects with an AbortError when `signal` aborts
 * while queued or waiting. A task already running is not interrupted here: it receives the same signal from its caller.
 */
export function createLimiter({
  concurrency = 1, minIntervalMs = 0, maxAttempts = RETRY_DEFAULTS.maxAttempts, baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
  maxDelayMs = RETRY_DEFAULTS.maxDelayMs, maxRetryAfterMs = RETRY_DEFAULTS.maxRetryAfterMs,
  maxTotalWaitMs = RETRY_DEFAULTS.maxTotalWaitMs, jitter = RETRY_DEFAULTS.jitter, clock = systemClock, random = Math.random,
} = {}) {
  let active = 0;
  let lastStart = null;
  const queue = [];

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (active < concurrency) { active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => { signal?.removeEventListener('abort', onAbort); resolve(); },
      };
      const onAbort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }
  function release() {
    const next = queue.shift();
    if (next) next.grant(); else active--;
  }
  async function spaced(signal) {
    if (lastStart !== null && minIntervalMs > 0) {
      const wait = lastStart + minIntervalMs - clock.now();
      if (wait > 0) await clock.sleep(wait, signal);
    }
    if (signal?.aborted) throw abortError();
    lastStart = clock.now();
  }
  function delayBefore(attempt, retryAfterMs) {
    const factor = 1 + jitter * (2 * random() - 1);
    const backoff = Math.min(baseDelayMs * 4 ** (attempt - 2) * factor, maxDelayMs);
    return Math.round(Math.max(retryAfterMs ?? 0, backoff));
  }

  async function run(task, { signal, budget = { waitedMs: 0 } } = {}) {
    await acquire(signal);
    let waitedMs = 0;
    try {
      for (let attempt = 1; ; attempt++) {
        await spaced(signal);
        const result = await task(attempt);
        const done = extra => ({ ...result, ...extra, attempts: attempt, waitedMs });
        if (result.ok || !result.retryable || attempt >= maxAttempts) return done();
        if (Number.isFinite(result.retryAfterMs) && result.retryAfterMs > maxRetryAfterMs) return done({ gaveUp: 'RETRY_AFTER_TOO_LONG' });
        const delay = delayBefore(attempt + 1, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 0);
        if (budget.waitedMs + delay > maxTotalWaitMs) return done({ gaveUp: 'WAIT_BUDGET' });
        budget.waitedMs += delay;
        waitedMs += delay;
        await clock.sleep(delay, signal);
      }
    } finally { release(); }
  }

  return { run, active: () => active, queued: () => queue.length };
}
