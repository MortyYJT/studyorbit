import { CourseworkError } from '../protocol/errors.js';
import { ED_ORIGIN } from './discovery.js';
import type { DiscoveryPage } from './discovery-adapters.js';
import type { CaptureLimiter } from './limiter.js';
import type { Page, Route } from 'playwright';

export type EdResponse = { kind: 'json'; status: number; body: unknown }
  | { kind: 'auth'; code: 'AUTH_EXPIRED'; status?: number }
  | { kind: 'gap'; status?: number; reason: 'unsafeEndpoint' | 'unavailable' | 'http' | 'invalidJson' | 'snapshot' };
export type EdSnapshot = (endpoint: string, body: unknown, status: number) => Promise<void>;
/** Only observed, bounded GET shapes are accepted. No arbitrary query, detail or renewal reads. */
export function safeEdEndpoint(endpoint: string): boolean {
  return /^\/api\/(?:user|courses\/\d+\/(?:lessons|resources|threads\?limit=30&sort=new)|lessons\/(?:slides\/)?\d+)$/.test(endpoint);
}
export class EdTransport {
  constructor(private readonly page: DiscoveryPage, private readonly limiter: CaptureLimiter, private readonly signal?: AbortSignal) {}
  async read(endpoint: string, options: { snapshot?: EdSnapshot } = {}): Promise<EdResponse> {
    if (!safeEdEndpoint(endpoint)) return { kind: 'gap', reason: 'unsafeEndpoint' };
    if (!this.page.url().startsWith(`${ED_ORIGIN}/`)) {
      try {
        await this.bootstrap();
      } catch (error) { this.rethrowStop(error); return { kind: 'gap', reason: 'unavailable' }; }
    }
    return this.limiter.attempt(async () => {
      let result: EdResponse;
      try {
        // All authentication stays in the page. Even reflected auth fields are withheld there.
        result = await this.page.evaluate<EdResponse>(`(async () => {
          if (location.origin !== 'https://edstem.org') return { kind: 'gap', reason: 'unavailable' };
          const token = localStorage.getItem('authToken:au');
          if (!token) return { kind: 'auth', code: 'AUTH_EXPIRED' };
          let response;
          try { response = await fetch(${JSON.stringify(endpoint)}, {
            method: 'GET', headers: { 'x-token': token }, credentials: 'same-origin', redirect: 'error'
          }); } catch { return { kind: 'gap', reason: 'unavailable' }; }
          const status = response.status;
          if (status === 401 || status === 403) return { kind: 'auth', code: 'AUTH_EXPIRED', status };
          if (response.redirected || !response.ok) return { kind: 'gap', reason: 'http', status };
          let body;
          try { body = await response.json(); } catch { return { kind: 'gap', reason: 'invalidJson', status }; }
          if (${JSON.stringify(endpoint)} === '/api/user') {
            if (!Array.isArray(body?.courses)) return { kind: 'gap', reason: 'invalidJson', status };
            body = body.courses;
          }
          const clean = value => {
            if (typeof value === 'string') return value.split(token).join('[withheld]');
            if (Array.isArray(value)) return value.map(clean);
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
              .filter(([key]) => !key.includes(token) && !/^(?:headers|cookies?|authorization|x-token|.*token.*|push_key|push_subscriptions)$/i.test(key))
              .map(([key, item]) => [key, clean(item)]));
            return value;
          };
          return { kind: 'json', status, body: clean(body) };
        })()`);
      } catch { return { kind: 'gap', reason: 'unavailable' }; }
      if (result.kind === 'json') {
        try { await options.snapshot?.(endpoint, result.body, result.status); }
        catch { return { kind: 'gap', reason: 'snapshot', status: result.status }; }
      }
      return result;
    }, this.signal);
  }
  private async bootstrap(): Promise<void> {
    // Keep DiscoveryPage's shared contract intact; fail closed if routing is unavailable.
    const page = this.page as DiscoveryPage & Pick<Page, 'route' | 'unroute'>;
    if (!page.route || !page.unroute) throw new Error('Ed navigation guard unavailable.');
    let next: string | undefined;
    const guard = async (route: Route) => {
      const request = route.request();
      if (!request.isNavigationRequest()) { await route.continue(); return; }
      if (new URL(request.url()).origin !== ED_ORIGIN) { await route.abort(); return; }
      try {
        // Playwright routes only the first URL in a redirect chain. Inspect 3xx before
        // the browser sees them, then start each validated same-origin hop ourselves.
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
        try {
          if (response.status() >= 300 && response.status() < 400) {
            const location = response.headers().location;
            const target = location ? new URL(location, request.url()) : undefined;
            if (target?.origin === ED_ORIGIN && !target.username && !target.password) next = target.href;
            await route.abort();
          } else await route.fulfill({ response });
        } finally { await response.dispose(); }
      } catch { await route.abort(); }
    };
    await page.route('**/*', guard);
    try {
      let target = `${ED_ORIGIN}/au/`;
      for (let hop = 0; hop < 20; hop++) {
        next = undefined;
        try {
          await this.limiter.attempt(() => page.goto(target, { waitUntil: 'load', timeout: 30000 }), this.signal);
          if (new URL(page.url()).origin !== ED_ORIGIN) throw new Error('Ed navigation left origin.');
          return;
        } catch (error) { this.rethrowStop(error); if (!next) throw error; }
        target = next;
      }
      throw new Error('Ed navigation redirect limit reached.');
    } finally { await page.unroute('**/*', guard); }
  }
  private rethrowStop(error: unknown): void {
    if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED' || error instanceof Error && error.name === 'AbortError') throw error;
  }
}
