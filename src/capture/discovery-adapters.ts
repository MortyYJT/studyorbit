import { CourseworkError } from '../protocol/errors.js';
import { CANVAS_ORIGIN, ED_ORIGIN, normalizeCanvasCourses, normalizeEdCourses, unavailable, type DiscoveryResult } from './discovery.js';
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
  try {
    return await limiter.attempt(async () => {
      const response = await page.goto(`${CANVAS_ORIGIN}/courses`, { waitUntil: 'load', timeout: 30000 }) as { status(): number } | null;
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
  } catch (error) { stopped(error); return unavailable('canvas'); }
}
/** The callback may write a local raw courses-only snapshot; it must not expose it to a model. */
export async function discoverEd(page: DiscoveryPage, limiter: CaptureLimiter,
  options: { signal?: AbortSignal; snapshot?: (courses: unknown[]) => Promise<void> } = {}): Promise<DiscoveryResult> {
  try {
    if (!page.url().startsWith(`${ED_ORIGIN}/`)) {
      await limiter.attempt(() => page.goto(`${ED_ORIGIN}/au/`, { waitUntil: 'load', timeout: 30000 }), options.signal);
    }
    return await limiter.attempt(async () => {
      // This entire function runs inside the page. Neither auth headers nor the full body cross the boundary.
      const response = await page.evaluate(async () => {
        if (location.origin !== 'https://edstem.org') return { kind: 'unavailable' as const };
        const token = localStorage.getItem('authToken:au');
        if (!token) return { kind: 'auth' as const };
        try {
          const result = await fetch('/api/user', { method: 'GET', headers: { 'x-token': token }, credentials: 'same-origin', redirect: 'error' });
          if (result.status === 401 || result.status === 403) return { kind: 'auth' as const };
          if (!result.ok) return { kind: 'unavailable' as const };
          const body = await result.json();
          if (!Array.isArray(body?.courses)) return { kind: 'unavailable' as const };
          return { kind: 'courses' as const, courses: body.courses as unknown[] };
        } catch { return { kind: 'unavailable' as const }; }
      });
      if (response.kind !== 'courses') return unavailable('ed', response.kind === 'auth' ? 'AUTH_EXPIRED' : 'SOURCE_UNAVAILABLE');
      const normalized = normalizeEdCourses(response.courses);
      if (normalized.status === 'available') await options.snapshot?.(response.courses);
      return normalized;
    }, options.signal);
  } catch (error) { stopped(error); return unavailable('ed'); }
}
