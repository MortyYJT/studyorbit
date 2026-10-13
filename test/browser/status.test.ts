import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { browserStatus } from '../../src/browser/status.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';

function setup(canvas = 200, ed = 200, token: string | null = 'private-token', region = 'au') {
  let now = 0; const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const limiter = new RequestLimiter(clock);
  const calls: { site: string; url: string; options: RequestInit }[] = [];
  const pages: { close: ReturnType<typeof vi.fn>; goto: ReturnType<typeof vi.fn> }[] = [];
  const bodies = vi.fn(() => { throw new Error('Body with Private Name must not be read'); });
  const tokens = vi.fn((key: string) => key === `authToken:${region}` ? token : null);
  const connect = vi.fn(async () => ({ contexts: () => [{ newPage: async () => {
    let url = 'about:blank';
    const page = { close: vi.fn(async () => {}), url: () => url,
      goto: vi.fn(async (target: string) => { url = canvas === 302 && target.includes('canvas.') ? 'https://login.example.invalid/' : target; }),
      evaluate: async <T>(expression: string): Promise<T> => {
        const location = new URL(url);
        return runInNewContext(expression, { location, URL, AbortSignal, localStorage: { getItem: tokens },
          fetch: async (path: string, options: RequestInit) => {
            const site = url.includes('canvas.') ? 'canvas' : 'ed'; calls.push({ site, url: path, options });
            const status = site === 'canvas' ? canvas : ed;
            return { status, ok: status === 200, redirected: false, type: 'basic', url: new URL(path, url).href,
              json: bodies, text: bodies };
          } });
      } };
    pages.push(page); return page;
  } }], close: vi.fn(async () => {}) }));
  const resident = { current: () => ({ endpoint: 'http://127.0.0.1:43210', pid: 12345, browser: 'msedge' as const, startedAt: '2026-01-01T00:00:00.000Z' }) };
  return { resident, connect, clock, limiter, calls, pages, bodies, tokens };
}
it.each([[200, 200, 'signedIn', 'signedIn'], [302, 200, 'signedOut', 'signedIn'], [401, 403, 'signedOut', 'signedOut'], [500, 500, 'unknown', 'unknown']])(
  '3.3 Canvas %s / Ed %s returns safe states, shared limiter and cleans owned tabs', async (canvas, ed, c, e) => {
    const s = setup(canvas as number, ed as number);
    const result = await browserStatus(s);
    expect(result.canvas).toMatchObject({ state: c, checkedAt: expect.any(String) });
    expect(result.ed).toMatchObject({ state: e, checkedAt: expect.any(String) });
    if (c === 'signedOut') expect(result.canvas.hint).toMatchObject({ code: 'AUTH_EXPIRED', next: expect.stringMatching(/sign in/i) });
    if (e === 'signedOut') expect(result.ed.hint).toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(s.limiter.attempts).toBe(canvas === 302 ? 3 : 4);
    expect(s.clock.now()).toBeGreaterThanOrEqual(2000);
    expect(s.bodies).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private-token|Private Name|43210|body|endpoint/);
    s.pages.forEach(page => expect(page.close).toHaveBeenCalledOnce());
    expect(s.calls.find(call => call.site === 'canvas')?.options.headers).toBeUndefined();
    if (s.calls.some(call => call.site === 'ed')) expect(s.calls.find(call => call.site === 'ed')!.options.headers).toEqual({ 'x-token': 'private-token' });
  });
it('3.3 missing regional Ed token is signedOut without an API request; regional token uses x-token only', async () => {
  const missing = setup(200, 200, null);
  expect((await browserStatus(missing)).ed.state).toBe('signedOut');
  expect(missing.calls.map(call => call.site)).toEqual(['canvas']);
  const us = setup(200, 200, 'private-token', 'us');
  expect((await browserStatus({ ...us, edRegion: 'us' })).ed.state).toBe('signedIn');
  expect(us.tokens).toHaveBeenCalledWith('authToken:us');
  expect(us.calls.find(call => call.site === 'ed')!.url).toBe('/api/user');
});
it('3.3 registry exposes browser.status at L0 and CLI dispatches the same safe result', async () => {
  const s = setup(); const context = createFakeContext();
  const registry = createRegistry({ browser: { status: () => browserStatus(s) } });
  expect(registry.get('browser.status')?.level).toBe(0);
  expect(await dispatch(registry, 'browser.status', {}, context)).toMatchObject({ ok: true, data: { canvas: { state: 'signedIn' } } });
  const lines: string[] = [];
  await parseProtocolCLI(['browser', 'status'], { registry, context, stdout: line => lines.push(line) });
  expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!)).toMatchObject({ command: 'browser.status', ok: true });
});
