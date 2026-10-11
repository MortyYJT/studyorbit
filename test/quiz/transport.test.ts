import { afterEach, expect, it, vi } from 'vitest';
import { readSelectedQuiz } from '../../src/quiz/read/adapter.js';
import { EdTransport, type EdResponse } from '../../src/capture/ed-transport.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import type { DiscoveryPage } from '../../src/capture/discovery-adapters.js';
import { selected, target } from './synthetic.js';
const bodies: unknown[] = [{ lessons: [{ id: 11, kind: 'attempt' }, { id: 99, kind: 'content' }] },
  { lesson: { id: 11, slides: [{ id: 21 }] } }, { slide: { id: 21, questions: [] } }];
const reader = (responses: EdResponse[] = bodies.map(body => ({ kind: 'json', status: 200, body }))) => ({ read: vi.fn(async (_endpoint: string) => responses.shift()!) });
afterEach(() => vi.unstubAllGlobals());
it('reads only a discovered selected attempt and its referenced slides without view or snapshots', async () => {
  const transport = reader();
  const result = await readSelectedQuiz(target, selected, transport);
  expect(result.slides).toHaveLength(1);
  expect(transport.read.mock.calls.map(call => call[0])).toEqual(['/api/courses/7/lessons', '/api/lessons/11', '/api/lessons/slides/21']);
  expect(transport.read.mock.calls.every(call => call.length === 1)).toBe(true);
});
it.each([{ course: '8', lesson: '11' }, { course: '7', lesson: '11?view=1' }, { course: '7', lesson: '99' }, { course: '7', lesson: '12' }])('refuses forged target %j before any detail GET', async input => {
  const transport = reader();
  await expect(readSelectedQuiz(input, selected, transport)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|NOT_FOUND/) });
  expect(transport.read.mock.calls.length).toBeLessThanOrEqual(1);
});
it.each([401, 403, 429, 400, 404])('stops on HTTP %i without retry or unsafe fallback', async status => {
  const transport = reader([{ kind: 'gap', status, reason: 'http' }]);
  await expect(readSelectedQuiz(target, selected, transport)).rejects.toMatchObject({ code: status === 401 || status === 403 ? 'AUTH_EXPIRED' : 'SOURCE_UNAVAILABLE' });
  expect(transport.read).toHaveBeenCalledTimes(1);
});
it('missing token stops at discovery', async () => {
  const transport = reader([{ kind: 'auth', code: 'AUTH_EXPIRED' }]);
  await expect(readSelectedQuiz(target, selected, transport)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  expect(transport.read).toHaveBeenCalledTimes(1);
});
it('withholds mismatched lesson/slide identity and malformed references', async () => {
  for (const detail of [{ lesson: { id: 12, slides: [] } }, { lesson: { id: 11, slides: [{ id: 'https://evil.invalid' }] } }]) {
    const transport = reader([{ kind: 'json', status: 200, body: bodies[0] }, { kind: 'json', status: 200, body: detail }]);
    await expect(readSelectedQuiz(target, selected, transport)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(transport.read).toHaveBeenCalledTimes(2);
  }
});
it('reuses page-local AU token isolation and the shared budget/spacing at the Q1 boundary', async () => {
  let now = 0; const starts: number[] = []; const crossed: unknown[] = [];
  const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  const getItem = vi.fn((key: string) => key === 'authToken:au' ? 'synthetic-credential-sentinel' : null);
  vi.stubGlobal('localStorage', { getItem });
  let index = 0;
  const fetch = vi.fn(async (_url: string, options: { method: string; redirect: string; headers: unknown }) => {
    starts.push(now); expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'x-token': 'synthetic-credential-sentinel' } });
    return { ok: true, status: 200, redirected: false, json: async () => ({ ...(bodies[index++] as object), token: 'synthetic-credential-sentinel', reflection: 'synthetic-credential-sentinel' }) };
  });
  vi.stubGlobal('fetch', fetch);
  const page = { url: () => 'https://edstem.org/au/', evaluate: async (expression: string) => {
    const result = await Function(`return ${expression}`)(); crossed.push(result); return result;
  } } as unknown as DiscoveryPage;
  await readSelectedQuiz(target, selected, new EdTransport(page, limiter));
  expect(getItem).toHaveBeenCalledWith('authToken:au');
  expect(JSON.stringify(crossed)).not.toMatch(/synthetic-credential-sentinel|x-token|authToken/);
  expect(starts).toEqual([0, 1000, 2000]); expect(limiter.attempts).toBe(3);
  for (let i = 3; i < 299; i++) await limiter.attempt(async () => {});
  index = 0;
  await expect(readSelectedQuiz(target, selected, new EdTransport(page, limiter))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(fetch).toHaveBeenCalledTimes(4); expect(limiter.attempts).toBe(300);
});
