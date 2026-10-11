import { EdTransport } from './ed-transport.js';
import { CourseworkError } from '../protocol/errors.js';
import { CANVAS_ORIGIN, normalizeCanvasCourses, normalizeEdCourses, unavailable, type DiscoveryResult } from './discovery.js';
import type { CaptureLimiter } from './limiter.js';
export interface DiscoveryPage {
  url(): string;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  evaluate<T>(expression: string | (() => T | Promise<T>)): Promise<T>;
}
function stopped(error: unknown): void {
  if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED' || error instanceof Error && error.name === 'AbortError') throw error;
}
export async function discoverCanvas(page: DiscoveryPage, limiter: CaptureLimiter, signal?: AbortSignal): Promise<DiscoveryResult> {
  const previousUrl = page.url();
  const signedOut = () => {
    const url = new URL(page.url());
    return ['http:', 'https:'].includes(url.protocol) && (url.origin !== CANVAS_ORIGIN || url.pathname.startsWith('/login'));
  };
  try {
    return await limiter.attempt(async () => {
      const response = await page.goto(`${CANVAS_ORIGIN}/courses`, { waitUntil: 'load', timeout: 30000 }) as { status(): number } | null;
      if (signedOut()) return unavailable('canvas', 'AUTH_EXPIRED');
      if (new URL(page.url()).origin !== CANVAS_ORIGIN || new URL(page.url()).pathname !== '/courses' || response && response.status() >= 400) return unavailable('canvas');
      const rows = await page.evaluate<{ id: string; name: string; term: string; unpublished: boolean }[] | null>(`(() => {
        const table = document.querySelector('table#my_courses_table');
        if (!table) return null;
        const visibleText = element => {
          if (!element) return '';
          const copy = element.cloneNode(true);
          copy.querySelectorAll('.screenreader-only').forEach(node => node.remove());
          return copy.textContent?.trim() || '';
        };
        return Array.from(table.querySelectorAll('tr.course-list-table-row'), row => {
          const title = row.querySelector('.course-list-course-title-column');
          const link = title?.querySelector('a[href]');
          const match = /^\\/courses\\/(\\d+)\\/?$/.exec(link?.getAttribute('href') || '');
          return { id: match?.[1] || '', unpublished: row.classList.contains('course-list-unpublished-course-row'),
            name: visibleText(title), term: visibleText(row.querySelector('.course-list-term-column')) };
        });
      })()`);
      return normalizeCanvasCourses(rows);
    }, signal);
  } catch (error) {
    stopped(error);
    return unavailable('canvas', page.url() !== previousUrl && signedOut() ? 'AUTH_EXPIRED' : 'SOURCE_UNAVAILABLE');
  }
}
/** The callback may write a local raw courses-only snapshot; it must not expose it to a model. */
export async function discoverEd(page: DiscoveryPage, limiter: CaptureLimiter,
  options: { signal?: AbortSignal; snapshot?: (courses: unknown[]) => Promise<void> } = {}): Promise<DiscoveryResult> {
  try {
    const response = await new EdTransport(page, limiter, options.signal).read('/api/user', {
      snapshot: async (_endpoint, body) => {
        if (Array.isArray(body) && normalizeEdCourses(body).status === 'available') await options.snapshot?.(body);
      },
    });
    if (response.kind !== 'json') return unavailable('ed', response.kind === 'auth' ? 'AUTH_EXPIRED' : 'SOURCE_UNAVAILABLE');
    return normalizeEdCourses(response.body);
  } catch (error) { stopped(error); return unavailable('ed'); }
}
