import { afterEach, expect, it, vi } from 'vitest';
import type { Route } from 'playwright';

import { EdTransport, type EdPage } from '../../src/capture/ed-transport.js';
import { run } from '../../src/protocol/envelope.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
function budget() { let now = 0; return new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } }); }
afterEach(() => vi.unstubAllGlobals());
// Simulates Playwright's first-URL-only routing and automatic redirect following.
function bootstrap(redirects?: string | Record<string, string>, extraDocument = false, subframe?: string) {
  let navigating = 'https://edstem.org/au/';
  const redirect = () => typeof redirects === 'string' ? (navigating === 'https://edstem.org/au/' ? redirects : undefined) : redirects?.[navigating];
  let handler: ((route: Route) => Promise<void>) | undefined; let url = 'about:blank';
  const requested: string[] = []; let aborted = false; let fulfilled = false; let inSubframe = false;
  const route = {
    request: () => ({ url: () => navigating, isNavigationRequest: () => true,
      frame: () => ({ parentFrame: () => inSubframe ? {} : null }) }),
    fetch: vi.fn(async (options: { maxRedirects?: number }) => {
      const target = redirect(); requested.push(navigating);
      if (target && options.maxRedirects !== 0) requested.push(target);
      return { status: () => target ? 302 : 200, headers: () => target ? { location: target } : {}, dispose: vi.fn(async () => {}) };
    }),
    abort: vi.fn(async () => { aborted = true; }),
    continue: vi.fn(async () => { requested.push(navigating); if (redirect()) requested.push(redirect()!); }),
    fulfill: vi.fn(async () => { fulfilled = true; if (redirect()) requested.push(redirect()!); }),
  };
  const page = {
    url: () => url,
    route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }),
    unroute: vi.fn(async (_pattern: string, callback: typeof handler) => { expect(callback).toBe(handler); handler = undefined; }),
    goto: vi.fn(async (destination: string) => {
      navigating = destination; aborted = false; fulfilled = false;
      if (handler) await handler(route as unknown as Route);
      else requested.push(navigating, ...(redirect() ? [redirect()!] : []));
      if (aborted) throw Error('Synthetic navigation aborted');
      if (subframe && handler) {
        const main = navigating; navigating = subframe; inSubframe = true;
        await handler(route as unknown as Route);
        navigating = main; inSubframe = false; aborted = false;
      }
      if (extraDocument && handler) {
        navigating = 'https://edstem.org/au/extra';
        await handler(route as unknown as Route);
        if (aborted) throw Error('Synthetic extra navigation aborted');
      }
      url = fulfilled ? navigating : redirect() ?? navigating;
    }),
    evaluate: vi.fn(async (expression: string) => Function(`return ${expression}`)()),
  };
  return { page, route, requested };
}
it('refuses bootstrap redirect before sending any cross-origin request', async () => {
  for (const target of ['https://evil.invalid/login', 'http://edstem.org/au/', 'https://edstem.org:444/au/', 'https://edstem.org.evil.invalid/au/']) {
    const f = bootstrap(target); const limiter = budget(); const snapshot = vi.fn(async () => {});
    const result = await new EdTransport(f.page as EdPage, limiter).read('/api/user', { snapshot });
    expect(f.requested).not.toContain(target);
    expect(result).toMatchObject({ kind: 'gap', reason: 'unavailable' });
    expect(f.route.abort).toHaveBeenCalled(); expect(f.page.evaluate).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled(); expect(limiter.attempts).toBe(1);
    expect(f.page.unroute).toHaveBeenCalled();
  }
});
it('loads a direct Ed bootstrap and removes only its own navigation guard', async () => {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-secret' });
  const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ courses: [] }) })); vi.stubGlobal('fetch', fetch);
  const f = bootstrap(); const limiter = budget();
  expect(await new EdTransport(f.page as EdPage, limiter).read('/api/user')).toMatchObject({ kind: 'json', body: [] });
  expect(f.route.fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
  expect(f.route.fulfill).toHaveBeenCalled(); expect(f.page.unroute).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1); expect(limiter.attempts).toBe(2);
});

it('checks every same-origin redirect hop before any later external redirect', async () => {
  const f = bootstrap({ 'https://edstem.org/au/': '/au/dashboard',
    'https://edstem.org/au/dashboard': 'https://evil.invalid/login' });
  const limiter = budget();
  expect(await new EdTransport(f.page as EdPage, limiter).read('/api/user')).toMatchObject({ kind: 'gap', reason: 'unavailable' });
  expect(f.requested).toEqual(['https://edstem.org/au/', 'https://edstem.org/au/dashboard']);
  expect(f.page.evaluate).not.toHaveBeenCalled(); expect(limiter.attempts).toBe(2);
  expect(f.page.unroute).toHaveBeenCalledTimes(1);
});
it('follows a validated same-origin redirect as a separate budgeted navigation', async () => {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-secret' });
  vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ courses: [] }) }));
  const f = bootstrap('/au/dashboard'); const limiter = budget();
  expect(await new EdTransport(f.page as EdPage, limiter).read('/api/user')).toMatchObject({ kind: 'json' });
  expect(f.requested).toEqual(['https://edstem.org/au/', 'https://edstem.org/au/dashboard']);
  expect(limiter.attempts).toBe(3); expect(f.page.unroute).toHaveBeenCalledTimes(1);
});

it('budgets and spaces two document requests during one bootstrap', async () => {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-secret' });
  vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ courses: [] }) }));
  let now = 0; const starts: number[] = [];
  const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const f = bootstrap(undefined, true); const fetch = f.route.fetch.getMockImplementation()!;
  f.route.fetch.mockImplementation(async options => { starts.push(now); const response = await fetch(options); now += 200; return response; });
  expect(await new EdTransport(f.page as EdPage, limiter).read('/api/user')).toMatchObject({ kind: 'json' });
  expect(f.page.goto).toHaveBeenCalledTimes(1);
  expect(starts).toEqual([0, 1200]); expect(limiter.attempts).toBe(3);
});
it('replaces failing Playwright cookie call logs before errors or output can escape', async () => {
  const cookie = 'synthetic-bootstrap-cookie-secret';
  const f = bootstrap();
  f.route.fetch.mockRejectedValue(Error(`route.fetch failed\nCall log: Cookie: session=${cookie}\nSet-Cookie: session=${cookie}`));
  // Playwright may surface route failures through navigation as well.
  const goto = f.page.goto.getMockImplementation()!;
  f.page.goto.mockImplementation(async destination => { try { await goto(destination); } catch { throw Error(`page.goto failed\nCall log: Cookie: session=${cookie}`); } });
  const logs = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const snapshot = vi.fn(async () => {});
  try {
    const transport = new EdTransport(f.page as EdPage, budget());
    // Exercise the internal error boundary: read() suppressing the error is insufficient.
    const failure = await (transport as unknown as { bootstrap(): Promise<void> }).bootstrap().catch(error => error);
    expect(failure).toMatchObject({ name: 'CourseworkError', code: 'SOURCE_UNAVAILABLE', message: 'Ed navigation unavailable.' });
    expect(String(failure)).not.toContain(cookie); expect(failure.stack).not.toContain(cookie);
    const envelope = await run('capture', () => transport.read('/api/user', { snapshot }));
    expect(JSON.stringify(envelope)).not.toContain(cookie);
    expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toContain(cookie);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(cookie);
    expect(snapshot).not.toHaveBeenCalled();
  } finally { logs.forEach(log => log.mockRestore()); stdout.mockRestore(); }
});

it('refuses a second bootstrap document when the first exhausts the shared cap', async () => {
  const f = bootstrap(undefined, true); const limiter = budget();
  for (let i = 0; i < 299; i++) await limiter.attempt(async () => {});
  await expect(new EdTransport(f.page as EdPage, limiter).read('/api/user')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(f.route.fetch).toHaveBeenCalledTimes(1); expect(limiter.attempts).toBe(300);
  expect(f.page.evaluate).not.toHaveBeenCalled(); expect(f.page.unroute).toHaveBeenCalledTimes(1);
});
it('cancels the second bootstrap document without fetching or leaking route errors', async () => {
  const f = bootstrap(undefined, true); const controller = new AbortController();
  const fetch = f.route.fetch.getMockImplementation()!;
  f.route.fetch.mockImplementation(async options => { const response = await fetch(options); controller.abort(); return response; });
  const limiter = budget();
  await expect(new EdTransport(f.page as EdPage, limiter, controller.signal).read('/api/user')).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.route.fetch).toHaveBeenCalledTimes(1); expect(limiter.attempts).toBe(1);
  expect(f.page.evaluate).not.toHaveBeenCalled(); expect(f.page.unroute).toHaveBeenCalledTimes(1);
});
it('preserves cancellation after a document succeeds while goto still waits for load', async () => {
  const f = bootstrap(); const controller = new AbortController();
  const goto = f.page.goto.getMockImplementation()!;
  f.page.goto.mockImplementation(async destination => {
    await goto(destination); controller.abort();
    throw Error('Synthetic private cookie call log during load');
  });
  await expect(new EdTransport(f.page as EdPage, budget(), controller.signal).read('/api/user'))
    .rejects.toMatchObject({ name: 'AbortError', message: 'Capture cancelled.' });
  expect(f.page.evaluate).not.toHaveBeenCalled(); expect(f.page.unroute).toHaveBeenCalledTimes(1);
});

it('blocks a cross-origin iframe navigation without failing the Ed bootstrap', async () => {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-secret' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ courses: [] }) })));
  const f = bootstrap(undefined, false, 'https://widget.invalid/frame'); const limiter = budget();
  expect(await new EdTransport(f.page as EdPage, limiter).read('/api/user')).toMatchObject({ kind: 'json', body: [] });
  expect(f.requested).not.toContain('https://widget.invalid/frame');
  expect(f.route.abort).toHaveBeenCalled(); expect(f.page.unroute).toHaveBeenCalledTimes(1);
});
