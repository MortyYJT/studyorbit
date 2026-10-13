import type { Page } from 'playwright';
import { z } from 'zod';
import { CANVAS_ORIGIN } from '../sync/ed-scope.js';
import { ED_ORIGIN, safeEdEndpoint } from '../capture/ed-transport.js';
import { RequestLimiter, type CaptureLimiter, type RequestClock } from '../capture/limiter.js';
import { CourseworkError } from '../protocol/errors.js';
import { withResidentBrowser, type AttachOptions, type OwnedPage } from './attach.js';
import { browserClock } from './resident.js';

export interface StatusPage extends OwnedPage {
  url(): string;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
}
export type SessionState = 'signedIn' | 'signedOut' | 'unknown';
export interface SiteStatus { state: SessionState; checkedAt: string; hint?: { code: 'AUTH_EXPIRED'; next: `Sign in to ${'Canvas' | 'Ed'} by hand in the resident browser.` } }
export interface BrowserStatus { canvas: SiteStatus; ed: SiteStatus }
export interface StatusOptions<P extends StatusPage = Page> extends AttachOptions<P> {
  limiter?: CaptureLimiter; clock?: RequestClock; edRegion?: 'au' | 'us' | 'eu';
}
// One process-wide limiter shared by status calls; other browser readers can inject their shared instance.
const statusLimiter = new RequestLimiter();
const sessionState = z.enum(['signedIn', 'signedOut', 'unknown']);
/** Only a three-valued state crosses the page boundary. No response body is read. */
export async function browserStatus<P extends StatusPage = Page>(options: StatusOptions<P> = {}): Promise<BrowserStatus> {
  const limiter = options.limiter ?? statusLimiter; const clock = options.clock ?? browserClock;
  return withResidentBrowser(options, async session => {
    const check = async (site: 'canvas' | 'ed'): Promise<SiteStatus> => {
      let state: SessionState = 'unknown';
      try {
        const page = await session.newPage();
        const origin = site === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN;
        const region = options.edRegion ?? 'au';
        await limiter.attempt(() => page.goto(site === 'canvas' ? `${origin}/` : `${origin}/${region}/`, { waitUntil: 'domcontentloaded', timeout: 10000 }));
        const landed = new URL(page.url());
        if (landed.origin !== origin || /\/login(?:\/|$)/i.test(landed.pathname)) state = 'signedOut';
        else {
          const endpoint = site === 'canvas' ? '/api/v1/users/self' : '/api/user';
          if (site === 'ed' && !safeEdEndpoint(endpoint)) throw new Error('Unsafe Ed endpoint.');
          state = sessionState.parse(await limiter.attempt(() => page.evaluate<SessionState>(`(async () => {
            if (location.origin !== ${JSON.stringify(origin)}) return 'unknown';
            let headers;
            ${site === 'ed' ? `
              const region = location.pathname.split('/')[1];
              if (!['au', 'us', 'eu'].includes(region)) return 'unknown';
              const token = localStorage.getItem('authToken:' + region);
              if (!token) return 'signedOut';
              headers = { 'x-token': token };
            ` : ''}
            let response;
            try { response = await fetch(${JSON.stringify(endpoint)}, {
              method: 'GET', credentials: 'same-origin', redirect: 'manual',
              signal: AbortSignal.timeout(10000), ...(headers ? { headers } : {})
            }); } catch { return 'unknown'; }
            if (response.status === 401 ${site === 'ed' ? '|| response.status === 403' : ''}) return 'signedOut';
            if (response.type === 'opaqueredirect' || response.redirected || response.status >= 300 && response.status < 400) return 'signedOut';
            return response.ok ? 'signedIn' : 'unknown';
          })()`)));
        }
      } catch (error) {
        if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') throw error;
        // Navigation/evaluation failures remain content-free and isolated per site.
      }
      return { state, checkedAt: new Date(clock.now()).toISOString(), ...(state === 'signedOut'
        ? { hint: { code: 'AUTH_EXPIRED' as const, next: `Sign in to ${site === 'canvas' ? 'Canvas' : 'Ed'} by hand in the resident browser.` } } : {}) };
    };
    return { canvas: await check('canvas'), ed: await check('ed') };
  });
}
