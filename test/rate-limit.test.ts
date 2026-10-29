import { describe, expect, it } from 'vitest';
import { createLimiter, manualClock, type TaskResult } from '../scripts/lib/rate-limit.mjs';

// The per-platform limiter (design §9, decision #348) with an injected clock and random source: no real waiting.
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('createLimiter', () => {
  it('caps concurrency and starts queued tasks as slots free up', async () => {
    const clock = manualClock();
    const limiter = createLimiter({ concurrency: 2, clock });
    let active = 0, peak = 0;
    const releases: (() => void)[] = [];
    const task = () => new Promise<TaskResult<number>>(resolve => {
      active++; peak = Math.max(peak, active);
      releases.push(() => { active--; resolve({ ok: true, value: 1 }); });
    });
    const runs = Array.from({ length: 5 }, () => limiter.run(task));
    await settle();
    expect([active, releases.length]).toEqual([2, 2]);
    releases[0]!(); await settle();
    expect([active, releases.length]).toEqual([2, 3]);
    for (let index = 1; index < 5; index++) { releases[index]!(); await settle(); }
    expect((await Promise.all(runs)).map(result => result.ok)).toEqual([true, true, true, true, true]);
    expect(peak).toBe(2);
  });

  it('keeps a minimum interval between starts', async () => {
    const clock = manualClock(1000);
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 500, clock });
    const starts: number[] = [];
    const task = async () => { starts.push(clock.now()); return { ok: true as const, value: null }; };
    const first = limiter.run(task);
    const second = limiter.run(task);
    await first; await settle();
    expect(starts).toEqual([1000]);
    clock.advance(499); await settle();
    expect(starts).toEqual([1000]);
    clock.advance(1); await second;
    expect(starts).toEqual([1000, 1500]);
  });

  it('makes at most three attempts with delays 2 s and 8 s (±20 % jitter)', async () => {
    const clock = manualClock(0);
    const limiter = createLimiter({ clock, random: () => 0.5 });
    const starts: number[] = [];
    const run = limiter.run(async attempt => { starts.push(clock.now()); return { ok: false, retryable: true, error: `HTTP 503 #${attempt}` }; });
    await settle(); clock.advance(2000); await settle(); clock.advance(8000);
    const result = await run;
    expect(starts).toEqual([0, 2000, 10_000]);
    expect(result).toMatchObject({ ok: false, error: 'HTTP 503 #3', attempts: 3, waitedMs: 10_000 });

    for (const [random, delay] of [[0, 1600], [1, 2400]] as const) {
      const jittered = manualClock(0);
      const times: number[] = [];
      const once = createLimiter({ clock: jittered, random: () => random, maxAttempts: 2 })
        .run(async () => { times.push(jittered.now()); return { ok: false, retryable: true, error: 'x' }; });
      await settle(); jittered.advance(delay - 1); await settle();
      expect(times).toEqual([0]);
      jittered.advance(1); await once;
      expect(times).toEqual([0, delay]);
    }
  });

  it('honours Retry-After when longer than the backoff and caps the backoff at 30 s', async () => {
    const clock = manualClock(0);
    const times: number[] = [];
    const limiter = createLimiter({ clock, random: () => 0.5, maxAttempts: 2 });
    const run = limiter.run(async attempt => { times.push(clock.now()); return attempt === 1 ? { ok: false, retryable: true, retryAfterMs: 3000, error: '429' } : { ok: true, value: 'saved' }; });
    await settle(); clock.advance(2999); await settle();
    expect(times).toEqual([0]);
    clock.advance(1);
    expect(await run).toMatchObject({ ok: true, value: 'saved', attempts: 2 });
    expect(times).toEqual([0, 3000]);

    const capped = manualClock(0);
    const long = createLimiter({ clock: capped, random: () => 1, maxAttempts: 5, baseDelayMs: 20_000 });
    const delays: number[] = [];
    let last = 0;
    const longRun = long.run(async attempt => { delays.push(capped.now() - last); last = capped.now(); return attempt < 3 ? { ok: false, retryable: true, error: 'x' } : { ok: true, value: 1 }; });
    await settle(); capped.advance(24_000); await settle(); capped.advance(30_000);
    await longRun;
    expect(delays).toEqual([0, 24_000, 30_000]);
  });

  it('does not wait for a Retry-After above 60 s', async () => {
    const clock = manualClock(0);
    const calls: number[] = [];
    const result = await createLimiter({ clock }).run(async attempt => { calls.push(attempt); return { ok: false, retryable: true, retryAfterMs: 61_000, error: 'busy' }; });
    expect(calls).toEqual([1]);
    expect(result).toMatchObject({ ok: false, error: 'busy', attempts: 1, gaveUp: 'RETRY_AFTER_TOO_LONG', waitedMs: 0 });
  });

  it('waits at most 2 minutes in total per budget', async () => {
    const clock = manualClock(0);
    const budget = { waitedMs: 0 };
    const limiter = createLimiter({ clock, maxAttempts: 10 });
    const calls: number[] = [];
    const run = limiter.run(async attempt => { calls.push(clock.now()); return { ok: false, retryable: true, retryAfterMs: 50_000, error: 'busy' }; }, { budget });
    for (let step = 0; step < 6; step++) { await settle(); clock.advance(50_000); }
    const result = await run;
    // 50 s + 50 s = 100 s; a third wait would make 150 s > 120 s.
    expect(calls).toEqual([0, 50_000, 100_000]);
    expect(result).toMatchObject({ gaveUp: 'WAIT_BUDGET', attempts: 3, waitedMs: 100_000 });
    expect(budget.waitedMs).toBe(100_000);
    // A second task with the same budget gets only the remaining 20 s.
    const again = await createLimiter({ clock, maxAttempts: 3 }).run(async () => ({ ok: false, retryable: true, retryAfterMs: 30_000, error: 'busy' }), { budget });
    expect(again).toMatchObject({ gaveUp: 'WAIT_BUDGET', attempts: 1 });
  });

  it('returns a non-retryable failure at once', async () => {
    const clock = manualClock(0);
    let calls = 0;
    const result = await createLimiter({ clock }).run(async () => { calls++; return { ok: false, retryable: false, error: 'HTTP 401' }; });
    expect([calls, result.ok, result.attempts, result.error]).toEqual([1, false, 1, 'HTTP 401']);
  });

  it('rejects at once when aborted during a backoff wait or while queued, without another attempt', async () => {
    const clock = manualClock(0);
    const limiter = createLimiter({ clock, concurrency: 1 });
    const controller = new AbortController();
    let calls = 0;
    const waiting = limiter.run(async () => { calls++; return { ok: false, retryable: true, retryAfterMs: 8000, error: '429' }; }, { signal: controller.signal });
    const queued = limiter.run(async () => { calls++; return { ok: true, value: 1 }; }, { signal: controller.signal });
    await settle();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    clock.advance(60_000); await settle();
    expect(calls).toBe(1);
    await expect(limiter.run(async () => ({ ok: true, value: 1 }), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    // The slot was released: a new task runs.
    expect(await limiter.run(async () => ({ ok: true, value: 2 }))).toMatchObject({ ok: true, value: 2 });
  });
});
