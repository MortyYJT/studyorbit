import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crawlsDir } from '../config/data-dir.js';
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
  evaluate(expression: string): Promise<string[]>;
  close(): Promise<void>;
}
export interface CrawlSummary {
  startedAt: string; durationMs: number; saved: number; failed: number;
  status: 'completed' | 'capReached' | 'signedOut' | 'aborted'; failedUrls: string[];
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
    save: (page: P) => Promise<unknown>; signal?: AbortSignal;
    clock?: { now(): number; sleep(ms: number): Promise<void> };
    writeSummary?: (summary: CrawlSummary) => Promise<void>; log: (message: string) => void;
    onTab?: (page: P | undefined) => void;
  },
): Promise<CrawlSummary | undefined> {
  const origin = crawlOrigin(startUrl);
  if (!origin) { options.log('Open a Canvas course page first.'); return; }
  const clock = options.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const started = clock.now();
  const summary: CrawlSummary = { startedAt: new Date(started).toISOString(), durationMs: 0, saved: 0, failed: 0, status: 'completed', failedUrls: [] };
  let page: P | undefined;
  let attempted = 0;
  let ended: number | undefined;
  const details: string[] = [];
  const queue = [`${origin}/courses`];
  try {
    page = await context.openHiddenPage();
    options.onTab?.(page);
    while (queue.length || details.length) {
      if (options.signal?.aborted) { summary.status = 'aborted'; break; }
      if (attempted >= CRAWL_CAP) { summary.status = 'capReached'; break; }
      if (ended !== undefined) await clock.sleep(Math.max(0, 1000 - (clock.now() - ended)));
      if (options.signal?.aborted) { summary.status = 'aborted'; break; }
      const target = queue.shift() ?? details.shift()!;
      attempted++;
      const loadStarted = clock.now();
      let hrefs: string[] | undefined;
      try {
        const response = await page.goto(target, { waitUntil: 'load', timeout: 30000 });
        if (isSignedOut(page.url(), origin)) { summary.status = 'signedOut'; break; }
        if (response && response.status() >= 400) throw new Error('HTTP error');
        const remaining = 30000 - (clock.now() - loadStarted);
        if (remaining > 0) {
          try { await page.waitForLoadState('networkidle', { timeout: remaining }); }
          catch (error) { if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error; }
        }
        if (isSignedOut(page.url(), origin)) { summary.status = 'signedOut'; break; }
        // Only listing pages need link discovery; capture the rendered DOM before saving.
        if (target === `${origin}/courses` || /^\/courses\/\d+\/(assignments|announcements)$/.test(new URL(target).pathname)) {
          hrefs = await page.evaluate('Array.from(document.querySelectorAll("[href]"), element => element.getAttribute("href"))');
        }
        await options.save(page);
        summary.saved++;
      } catch {
        if (isSignedOut(page.url(), origin)) { summary.status = 'signedOut'; break; }
        hrefs = undefined;
        summary.failed++; summary.failedUrls.push(cleanUrl(target));
      }
      if (options.signal?.aborted) { summary.status = 'aborted'; break; }
      if (hrefs) {
        if (target === `${origin}/courses`) queue.push(...fixedPages(origin, courseLinks(hrefs, page.url())));
        else {
          const match = /^\/courses\/(\d+)\/(assignments|announcements)$/.exec(new URL(target).pathname);
          if (match) details.push(...detailLinks(hrefs, page.url(), match[1], match[2] === 'assignments' ? 'assignments' : 'discussion_topics'));
        }
      }
      ended = clock.now();
      if (options.signal?.aborted) { summary.status = 'aborted'; break; }
      if (attempted >= CRAWL_CAP) { summary.status = 'capReached'; break; }
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
