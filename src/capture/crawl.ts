import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crawlsDir } from '../config/data-dir.js';
import { discoverCanvas } from './discovery-adapters.js';
import { courseKey, type DiscoveryResult } from './discovery.js';
import { RequestLimiter, type CaptureLimiter } from './limiter.js';
import { validateSelection, type CaptureSelection } from './selection-store.js';
import { CourseworkError } from '../protocol/errors.js';
import { cleanUrl } from './snapshot.js';

export const CRAWL_CAP = 300;
export function crawlOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (['http:', 'https:'].includes(url.protocol) && url.hostname === 'canvas.lms.unimelb.edu.au'
      && (url.pathname === '/courses' || url.pathname.startsWith('/courses/'))) return url.origin;
  } catch { /* Invalid active URLs cannot start a crawl. */ }
  return undefined;
}
function resolvedLinks(hrefs: string[], pageUrl: string): URL[] {
  const origin = new URL(pageUrl).origin;
  return hrefs.flatMap(href => {
    try {
      const url = new URL(href, pageUrl);
      if (url.origin !== origin) return [];
      url.search = ''; url.hash = ''; url.username = ''; url.password = '';
      return [url];
    } catch { return []; }
  });
}
export function courseLinks(hrefs: string[], pageUrl: string): string[] {
  return [...new Set(resolvedLinks(hrefs, pageUrl).flatMap(url => {
    const match = /^\/courses\/(\d+)\/?$/.exec(url.pathname);
    return match ? [match[1]] : [];
  }))];
}
export function detailLinks(hrefs: string[], pageUrl: string, courseId: string, kind: 'assignments' | 'discussion_topics'): string[] {
  if (!/^\d+$/.test(courseId)) return [];
  const pattern = new RegExp(`^/courses/${courseId}/${kind}/\\d+/?$`);
  return [...new Set(resolvedLinks(hrefs, pageUrl).filter(url => pattern.test(url.pathname))
    .map(url => `${url.origin}${url.pathname.replace(/\/$/, '')}`))];
}
export function fixedPages(origin: string, ids: string[]): string[] {
  return ids.flatMap(id => ['assignments', 'announcements', 'grades', 'assignments/syllabus']
    .map(path => `${origin}/courses/${id}/${path}`));
}
export function isSignedOut(raw: string, origin: string): boolean {
  const url = new URL(raw);
  // Blank and browser error pages are not committed sign-in redirects.
  return ['http:', 'https:'].includes(url.protocol)
    && (url.origin !== origin || url.pathname.startsWith('/login'));
}
export interface CrawlPage {
  url(): string;
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<{ status(): number } | null>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
}
export function normalizeCanvasUrl(raw: string): string {
  const url = new URL(cleanUrl(raw));
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
export interface CanvasRedirect { requestedUrl: string; finalUrl: string; alreadySaved: boolean }
export interface CrawlSummary {
  startedAt: string; durationMs: number; saved: number; failed: number;
  status: 'completed' | 'capReached' | 'signedOut' | 'aborted'; failedUrls: string[];
}
export interface CanvasGap { code: 'SOURCE_UNAVAILABLE' | 'UNSELECTED_REDIRECT' | 'INELIGIBLE_FINAL_URL'; url?: string }
/** Content-free Canvas result. attempted counts this adapter's navigations only. */
export interface CanvasOutcome extends CrawlSummary {
  source: 'canvas'; attempted: number; duplicates: number; skipped: number;
  discoveryReused: boolean; missingIds: string[]; redirects: CanvasRedirect[]; gaps: CanvasGap[];
}
export function summaryFilename(startedAt: string): string {
  return new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-') + '.json';
}
export async function writeCrawlSummary(summary: CrawlSummary): Promise<void> {
  // Keep the ISO filename format while preserving runs started in the same second.
  let stamp = new Date(summary.startedAt).getTime();
  for (;;) {
    try {
      await writeFile(join(crawlsDir(), summaryFilename(new Date(stamp).toISOString())), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      stamp += 1000;
    }
  }
}
export async function runCrawl<P extends CrawlPage>(
  context: { openHiddenPage(): Promise<P> }, startUrl: string,
  options: {
    selection?: CaptureSelection; discovery?: DiscoveryResult; limiter?: CaptureLimiter;
    save: (page: P) => Promise<unknown>; signal?: AbortSignal;
    clock?: { now(): number; sleep(ms: number): Promise<void> };
    writeSummary?: (summary: CrawlSummary) => Promise<void>; log: (message: string) => void;
    onTab?: (page: P | undefined) => void;
  },
): Promise<CanvasOutcome | undefined> {
  const origin = crawlOrigin(startUrl);
  if (!origin) { options.log('Open a Canvas course page first.'); return; }
  const clock = options.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const started = clock.now();
  const summary: CanvasOutcome = { source: 'canvas', attempted: 0, duplicates: 0, skipped: 0, discoveryReused: options.discovery !== undefined, missingIds: [], redirects: [], gaps: [], startedAt: new Date(started).toISOString(), durationMs: 0, saved: 0, failed: 0, status: 'completed', failedUrls: [] };
  const selection = validateSelection(options.selection ?? { version: 1, courses: [] });
  const selected = selection.courses.filter(c => c.source === 'canvas' && c.origin === origin);
  const selectedKeys = new Set(selected.map(courseKey));
  const savedUrls = new Set<string>();
  const plan = (discovery: DiscoveryResult) => {
    if (discovery.source !== 'canvas' || discovery.status !== 'available') { summary.gaps.push({ code: 'SOURCE_UNAVAILABLE' }); return []; }
    summary.skipped += discovery.skipped;
    const available = new Set(discovery.courses.map(courseKey));
    summary.missingIds = selected.filter(c => !available.has(courseKey(c))).map(c => c.id);
    return fixedPages(origin, [...new Set(discovery.courses.filter(c => selectedKeys.has(courseKey(c))).map(c => c.id))]);
  };
  const limiter = options.limiter ?? new RequestLimiter(clock);
  let page: P | undefined;
  const details: string[] = [];
  const listing = `${origin}/courses`;
  const queue = options.discovery ? plan(options.discovery) : [listing];
  let committed = false;
  const ready = async (target: string) => {
    const loadStarted = clock.now();
    const previousUrl = page!.url();
    let response: { status(): number } | null;
    try {
      response = await page!.goto(target, { waitUntil: 'load', timeout: 30000 });
      committed = true;
    } catch (error) { committed = page!.url() !== previousUrl; throw error; }
    if (isSignedOut(page!.url(), origin)) return response;
    if (response && response.status() >= 400) throw new Error('HTTP error');
    const remaining = 30000 - (clock.now() - loadStarted);
    if (remaining > 0) {
      try { await page!.waitForLoadState('networkidle', { timeout: remaining }); }
      catch (error) { if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error; }
    }
    return response;
  };
  try {
    page = await context.openHiddenPage();
    options.onTab?.(page);
    while (queue.length || details.length) {
      const target = queue.shift() ?? details.shift()!;
      let redirectRecorded = false;
      committed = false;
      const recordRedirect = () => {
        if (!committed) return;
        try {
          const finalUrl = normalizeCanvasUrl(page!.url());
          const requestedUrl = normalizeCanvasUrl(target);
          if (!redirectRecorded && finalUrl !== requestedUrl) {
            summary.redirects.push({ requestedUrl, finalUrl, alreadySaved: savedUrls.has(finalUrl) });
            redirectRecorded = true;
          }
        } catch { /* Uncommitted blank/error pages have no HTTP final URL. */ }
      };
      try {
        await limiter.attempt(async () => {
          summary.attempted++;
          if (target === listing) {
            // The outer limiter includes readiness, discovery and the snapshot write.
            const discovery = await discoverCanvas({ url: () => page!.url(), goto: () => ready(listing),
              evaluate: <T>(expression: string | (() => T | Promise<T>)) => page!.evaluate(expression as string) as Promise<T>,
            }, { get attempts() { return limiter.attempts; }, attempt: operation => operation() });
            recordRedirect();
            if (isSignedOut(page!.url(), origin)) { summary.status = 'signedOut'; return; }
            if (discovery.status !== 'available') { summary.gaps.push({ code: 'SOURCE_UNAVAILABLE' }); throw new Error('Discovery unavailable'); }
            await options.save(page!); summary.saved++; savedUrls.add(normalizeCanvasUrl(page!.url()));
            queue.push(...plan(discovery));
          } else {
            await ready(target);
            recordRedirect();
            if (isSignedOut(page!.url(), origin)) { summary.status = 'signedOut'; return; }
            const finalUrl = normalizeCanvasUrl(page!.url());
            const requestedUrl = normalizeCanvasUrl(target);
            const alreadySaved = savedUrls.has(finalUrl);
            const finalCourseId = /^\/courses\/(\d+)(?:\/|$)/.exec(new URL(finalUrl).pathname)?.[1];
            if (!finalCourseId || !selected.some(c => c.id === finalCourseId)) {
              summary.skipped++; summary.gaps.push({ code: finalCourseId ? 'UNSELECTED_REDIRECT' : 'INELIGIBLE_FINAL_URL', url: finalUrl }); return;
            }
            if (alreadySaved) { summary.duplicates++; return; }
            let hrefs: string[] | undefined;
            if (finalUrl === requestedUrl && /^\/courses\/\d+\/(assignments|announcements)$/.test(new URL(target).pathname)) {
              hrefs = await page!.evaluate('Array.from(document.querySelectorAll("[href]"), element => element.getAttribute("href"))') as string[];
            }
            await options.save(page!); summary.saved++; savedUrls.add(finalUrl);
            if (!options.signal?.aborted && hrefs) {
              const match = /^\/courses\/(\d+)\/(assignments|announcements)$/.exec(new URL(target).pathname)!;
              details.push(...detailLinks(hrefs, page!.url(), match[1], match[2] === 'assignments' ? 'assignments' : 'discussion_topics'));
            }
          }
        }, options.signal);
      } catch (error) {
        recordRedirect();
        if (error instanceof Error && error.name === 'AbortError') { summary.status = 'aborted'; break; }
        if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') { summary.status = 'capReached'; break; }
        if (isSignedOut(page.url(), origin)) { summary.status = 'signedOut'; break; }
        summary.failed++; summary.failedUrls.push(cleanUrl(target));
      }
      if (options.signal?.aborted) { summary.status = 'aborted'; break; }
      if (summary.status === 'signedOut') break;
      if (limiter.attempts >= CRAWL_CAP) { summary.status = 'capReached'; break; }
    }
  } catch (error) {
    summary.status = 'aborted';
    if (!options.signal?.aborted) throw error;
  } finally {
    try { await page?.close(); } catch { /* The browser may already have closed. */ }
    options.onTab?.(undefined);
    // Settle the current load and its counts before cancellation wins over any exit reason.
    if (options.signal?.aborted) summary.status = 'aborted';
    summary.durationMs = clock.now() - started;
    await (options.writeSummary ?? writeCrawlSummary)(summary);
    if (summary.status === 'signedOut') options.log('Canvas session expired. Sign in again.');
    options.log(`Crawl summary: ${JSON.stringify(summary)}`);
  }
  return summary;
}
