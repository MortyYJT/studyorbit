import type { Page, Route } from 'playwright';
import { CourseworkError } from '../protocol/errors.js';
import type { CaptureLimiter } from './limiter.js';
import type { JsonResponse } from '../sync/canvas-reader.js';
import { CANVAS_ORIGIN } from '../sync/ed-scope.js';
export interface CanvasPage { url(): string; evaluate<T>(script: string): Promise<T> }
export function safeCanvasEndpoint(endpoint: string): boolean {
  return /^\/api\/v1\/(?:courses\?enrollment_type=student&enrollment_state=active&include\[\]=term&per_page=100&page=[1-9]\d?|courses\/[1-9]\d*\/(?:assignments|assignment_groups|modules)\?per_page=100&page=[1-9]\d?|courses\/[1-9]\d*\/assignments\/[1-9]\d*\/submissions\/self)$/.test(endpoint);
}
/** Cookie-authenticated reads only; the page never receives or creates a bearer credential. */
export class CanvasTransport {
  constructor(private readonly page: CanvasPage, private readonly limiter: CaptureLimiter) {}
  async read(endpoint: string): Promise<JsonResponse> {
    if (!safeCanvasEndpoint(endpoint)) return { kind: 'gap', reason: 'unsafeEndpoint' };
    if (!this.page.url().startsWith(`${CANVAS_ORIGIN}/`)) {
      const stopped = await this.bootstrap();
      if (stopped) return stopped;
    }
    return this.limiter.attempt(async () => {
      try {
        return await this.page.evaluate<JsonResponse>(`(async () => {
          if (location.origin !== ${JSON.stringify(CANVAS_ORIGIN)}) return { kind: 'auth', code: 'AUTH_EXPIRED' };
          let response;
          try { response = await fetch(${JSON.stringify(endpoint)}, { method: 'GET', credentials: 'same-origin', redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
          catch { return { kind: 'gap', reason: 'unavailable' }; }
          const status = response.status;
          if (status === 401 || status === 403 || response.type === 'opaqueredirect' || response.redirected || status >= 300 && status < 400) return { kind: 'auth', code: 'AUTH_EXPIRED', status };
          if (!response.ok) return { kind: 'gap', reason: 'http', status };
          let body;
          try { body = await response.json(); } catch { return { kind: 'gap', reason: 'invalidJson', status }; }
          const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:headers|cookies?|authorization|.*token.*|password)$/i.test(key)).map(([key, value]) => [key, clean(value)])) : value;
          const next = /<([^>]+)>;\\s*rel="next"/.exec(response.headers.get('link') || '')?.[1];
          return { kind: 'json', status, body: clean(body), ...(next ? { next } : {}) };
        })()`);
      } catch { return { kind: 'gap', reason: 'unavailable' }; }
    });
  }
  private async bootstrap(): Promise<JsonResponse | undefined> {
    const page = this.page as CanvasPage & Pick<Page, 'route' | 'unroute' | 'goto'>;
    if (!page.route || !page.unroute || !page.goto) return { kind: 'gap', reason: 'unavailable' };
    let failure: JsonResponse | undefined; let stopped: unknown; let next: string | undefined;
    const guard = async (route: Route) => {
      try {
        const request = route.request();
        if (!request.isNavigationRequest()) { await route.continue(); return; }
        const target = new URL(request.url());
        if (target.origin !== CANVAS_ORIGIN || target.username || target.password) {
          failure = { kind: 'auth', code: 'AUTH_EXPIRED' }; await route.abort(); return;
        }
        await this.limiter.attempt(async () => {
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
          try {
            const status = response.status();
            if (status === 401 || status === 403) { failure = { kind: 'auth', code: 'AUTH_EXPIRED', status }; await route.abort(); }
            else if (status >= 300 && status < 400) {
              const location = response.headers().location;
              const redirected = location ? new URL(location, request.url()) : undefined;
              if (redirected?.origin === CANVAS_ORIGIN && !redirected.username && !redirected.password) next = redirected.href;
              else failure = { kind: 'auth', code: 'AUTH_EXPIRED', status };
              await route.abort();
            } else await route.fulfill({ response });
          } finally { await response.dispose(); }
        });
      } catch (error) {
        if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') stopped = error;
        failure = { kind: 'gap', reason: 'unavailable' }; await route.abort().catch(() => {});
      }
    };
    try {
      await page.route('**/*', guard);
      let target = `${CANVAS_ORIGIN}/`;
      for (let hop = 0; hop < 20; hop++) {
        next = undefined;
        try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
        catch { if (!next && !failure && !stopped) failure = { kind: 'gap', reason: 'unavailable' }; }
        if (stopped) throw stopped;
        if (failure) return failure;
        if (next) { target = next; continue; }
        const landed = new URL(page.url());
        return landed.origin === CANVAS_ORIGIN && !/\/login(?:\/|$)/i.test(landed.pathname) ? undefined : { kind: 'auth', code: 'AUTH_EXPIRED' };
      }
      return { kind: 'gap', reason: 'unavailable' };
    } catch (error) {
      if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') throw error;
      return { kind: 'gap', reason: 'unavailable' };
    } finally { await page.unroute('**/*', guard); }
  }
}
