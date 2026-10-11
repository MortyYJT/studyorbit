import { afterEach, expect, it, vi } from 'vitest';
import { EdTransport } from '../../src/capture/ed-transport.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import type { DiscoveryPage } from '../../src/capture/discovery-adapters.js';
export function budget() { let now = 0; return new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } }); }
export function page() {
  return { url: () => 'https://edstem.org/au/', goto: vi.fn(),
    evaluate: async (expression: string) => Function(`return ${expression}`)() } as unknown as DiscoveryPage;
}
afterEach(() => vi.unstubAllGlobals());
export function session(status = 200, body: unknown = { lesson: { id: 11 } }) {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'synthetic-session-secret') });
  const fetch = vi.fn(async (_endpoint: string, _options: unknown) => ({ status, ok: status >= 200 && status < 300, redirected: false, json: async () => body }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
it('uses page-local x-token on each GET, no view or bearer and no exported auth', async () => {
  const fetch = session(); const limiter = budget(); const transport = new EdTransport(page(), limiter);
  for (const endpoint of ['/api/lessons/11', '/api/lessons/slides/12']) {
    const result = await transport.read(endpoint);
    expect(result).toMatchObject({ kind: 'json', status: 200 });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-session-secret|x-token|Authorization/);
    expect(fetch).toHaveBeenLastCalledWith(endpoint, { method: 'GET', headers: { 'x-token': 'synthetic-session-secret' }, credentials: 'same-origin', redirect: 'error' });
  }
  expect(localStorage.getItem).toHaveBeenCalledWith('authToken:au'); expect(limiter.attempts).toBe(2);
});
it('missing token stops without cookie fallback', async () => {
  const fetch = session(); vi.stubGlobal('localStorage', { getItem: () => null });
  expect(await new EdTransport(page(), budget()).read('/api/user')).toMatchObject({ kind: 'auth', code: 'AUTH_EXPIRED' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['https://edstem.org.evil.invalid/api/user', 'https://edstem.org:444/api/user', '//edstem.org/api/user', '/api/lessons/11?view=1', '/api/renew_token', '/api/courses/a/lessons', '/api/user#secret'])('refuses unsafe endpoint %s before fetching', async endpoint => {
  const fetch = session(); const limiter = budget();
  expect(await new EdTransport(page(), limiter).read(endpoint)).toMatchObject({ kind: 'gap' });
  expect(fetch).not.toHaveBeenCalled(); expect(limiter.attempts).toBe(0);
});
it('refuses page origin mismatch and redirects without exposing exception text', async () => {
  const fetch = session(); vi.stubGlobal('location', { origin: 'https://evil.invalid' });
  expect(await new EdTransport(page(), budget()).read('/api/user')).toMatchObject({ kind: 'gap' }); expect(fetch).not.toHaveBeenCalled();
  session(); vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    expect(options.redirect).toBe('error'); throw Error('synthetic-session-secret external redirect');
  }));
  const result = await new EdTransport(page(), budget()).read('/api/user');
  expect(result).toMatchObject({ kind: 'gap' }); expect(JSON.stringify(result)).not.toContain('synthetic-session-secret');
});
it('projects user response to courses and withholds reflected auth material', async () => {
  session(200, { courses: [], user: 'private', push_key: 'private', headers: { 'x-token': 'synthetic-session-secret' } });
  expect(await new EdTransport(page(), budget()).read('/api/user')).toMatchObject({ body: [] });
  session(200, { xml: '<document/>', token: 'synthetic-session-secret', headers: { 'x-token': 'synthetic-session-secret' }, reflection: 'synthetic-session-secret' });
  expect(JSON.stringify(await new EdTransport(page(), budget()).read('/api/lessons/11'))).not.toMatch(/synthetic-session-secret|x-token/);
});
it('includes snapshot completion in limiter spacing and bootstraps once', async () => {
  session(); let url = 'about:blank'; let now = 0; const starts: number[] = [];
  const p = page(); p.url = () => url; p.goto = vi.fn(async () => { starts.push(now); url = 'https://edstem.org/au/'; });
  const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const transport = new EdTransport(p, limiter);
  await transport.read('/api/lessons/11', { snapshot: async () => { starts.push(now); now += 500; } });
  await transport.read('/api/lessons/slides/12', { snapshot: async () => { starts.push(now); } });
  expect(starts).toEqual([0, 1000, 2500]); expect(limiter.attempts).toBe(3);
});
it('malformed JSON and no-view refusals produce safe gaps without retry', async () => {
  session(); const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw Error('private payload synthetic-session-secret'); } }));
  vi.stubGlobal('fetch', fetch);
  expect(await new EdTransport(page(), budget()).read('/api/lessons/11')).toEqual({ kind: 'gap', status: 200, reason: 'invalidJson' });
  expect(fetch).toHaveBeenCalledTimes(1);
  const refused = session(400); expect(await new EdTransport(page(), budget()).read('/api/lessons/slides/21')).toMatchObject({ kind: 'gap', status: 400 });
  expect(refused).toHaveBeenCalledTimes(1); expect(refused.mock.calls[0][0]).not.toContain('view');
});
it('no 301st GET starts after 299 shared attempts and one Ed read', async () => {
  const fetch = session(); const limiter = budget();
  for (let i = 0; i < 299; i++) await limiter.attempt(async () => {});
  const transport = new EdTransport(page(), limiter);
  await transport.read('/api/lessons/11');
  await expect(transport.read('/api/lessons/slides/21')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(fetch).toHaveBeenCalledTimes(1); expect(limiter.attempts).toBe(300);
});
