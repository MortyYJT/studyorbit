import { afterEach, expect, it, vi } from 'vitest';
import type { Route } from 'playwright';
import { discoverEd, type DiscoveryPage } from '../../src/capture/discovery-adapters.js';
import { EdTransport } from '../../src/capture/ed-transport.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
function budget() { let now = 0; return new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } }); }
afterEach(() => vi.unstubAllGlobals());
// Simulates Playwright's first-URL-only routing and automatic redirect following.
function bootstrap(redirects?: string | Record<string, string>) {
  let navigating = 'https://edstem.org/au/';
  const redirect = () => typeof redirects === 'string' ? (navigating === 'https://edstem.org/au/' ? redirects : undefined) : redirects?.[navigating];
  let handler: ((route: Route) => Promise<void>) | undefined; let url = 'about:blank';
  const requested: string[] = []; let aborted = false; let fulfilled = false;
  const route = {
    request: () => ({ url: () => navigating, isNavigationRequest: () => true }),
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
      url = fulfilled ? navigating : redirect() ?? navigating;
    }),
    evaluate: vi.fn(async (expression: string) => Function(`return ${expression}`)()),
  };
  return { page, route, requested };
}
it.each(['transport', 'discovery'])('refuses bootstrap redirect before sending any cross-origin request: %s', async mode => {
  for (const target of ['https://evil.invalid/login', 'http://edstem.org/au/', 'https://edstem.org:444/au/', 'https://edstem.org.evil.invalid/au/']) {
    const f = bootstrap(target); const limiter = budget(); const snapshot = vi.fn(async () => {});
    const result = mode === 'transport'
      ? await new EdTransport(f.page as DiscoveryPage, limiter).read('/api/user', { snapshot })
      : await discoverEd(f.page as DiscoveryPage, limiter, { snapshot });
    expect(f.requested).not.toContain(target);
    expect(result).toMatchObject(mode === 'transport' ? { kind: 'gap', reason: 'unavailable' } : { status: 'unavailable', error: { code: 'SOURCE_UNAVAILABLE' } });
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
  expect(await discoverEd(f.page as DiscoveryPage, limiter)).toMatchObject({ status: 'available', courses: [] });
  expect(f.route.fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
  expect(f.route.fulfill).toHaveBeenCalled(); expect(f.page.unroute).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1); expect(limiter.attempts).toBe(2);
});

it('checks every same-origin redirect hop before any later external redirect', async () => {
  const f = bootstrap({ 'https://edstem.org/au/': '/au/dashboard',
    'https://edstem.org/au/dashboard': 'https://evil.invalid/login' });
  const limiter = budget();
  expect(await new EdTransport(f.page as DiscoveryPage, limiter).read('/api/user')).toMatchObject({ kind: 'gap', reason: 'unavailable' });
  expect(f.requested).toEqual(['https://edstem.org/au/', 'https://edstem.org/au/dashboard']);
  expect(f.page.evaluate).not.toHaveBeenCalled(); expect(limiter.attempts).toBe(2);
  expect(f.page.unroute).toHaveBeenCalledTimes(1);
});
it('follows a validated same-origin redirect as a separate budgeted navigation', async () => {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-secret' });
  vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({ courses: [] }) }));
  const f = bootstrap('/au/dashboard'); const limiter = budget();
  expect(await discoverEd(f.page as DiscoveryPage, limiter)).toMatchObject({ status: 'available' });
  expect(f.requested).toEqual(['https://edstem.org/au/', 'https://edstem.org/au/dashboard']);
  expect(limiter.attempts).toBe(3); expect(f.page.unroute).toHaveBeenCalledTimes(1);
});
