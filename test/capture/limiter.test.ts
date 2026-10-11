import { it, expect } from 'vitest';
import { RequestLimiter } from '../../src/capture/limiter.js';
it('shares 300 attempts across discovery, failures, skips and bootstrap without retries', async () => {
  let now = 0; const starts: number[] = [];
  const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  for (let i = 0; i < 300; i++) {
    await limiter.attempt(async () => { starts.push(now); now += 20; if (i % 4 === 1) throw Error('synthetic failure'); return 'skip'; }).catch(() => {});
  }
  expect(limiter.attempts).toBe(300);
  expect(starts[299]).toBe(299 * 1020);
  await expect(limiter.attempt(async () => {})).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});
it('serializes concurrent requests through snapshot completion and cancels queued reads', async () => {
  let now = 0; const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const starts: number[] = [];
  await Promise.all([limiter.attempt(async () => { starts.push(now); now += 50; }), limiter.attempt(async () => { starts.push(now); })]);
  expect(starts).toEqual([0, 1050]);
  const controller = new AbortController(); controller.abort();
  await expect(limiter.attempt(async () => {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(limiter.attempts).toBe(2);
});
it('cancels during the inter-attempt wait without starting another request', async () => {
  const controller = new AbortController(); const operation = async () => 'saved';
  const limiter = new RequestLimiter({ now: () => 0, sleep: async () => { controller.abort(); } });
  await limiter.attempt(operation);
  await expect(limiter.attempt(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(limiter.attempts).toBe(1);
});
