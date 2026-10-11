import { CourseworkError } from '../protocol/errors.js';
import { ED_ORIGIN } from './discovery.js';
import type { DiscoveryPage } from './discovery-adapters.js';
import type { CaptureLimiter } from './limiter.js';

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
        await this.limiter.attempt(() => this.page.goto(`${ED_ORIGIN}/au/`, { waitUntil: 'load', timeout: 30000 }), this.signal);
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
              .filter(([key]) => !/^(?:headers|cookies?|authorization|x-token|.*token.*|push_key|push_subscriptions)$/i.test(key))
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
  private rethrowStop(error: unknown): void {
    if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED' || error instanceof Error && error.name === 'AbortError') throw error;
  }
}
