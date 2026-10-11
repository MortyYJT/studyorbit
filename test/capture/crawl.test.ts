import { expect, it, vi } from 'vitest';
import { crawlOrigin, courseLinks, detailLinks, fixedPages, isSignedOut, CRAWL_CAP, runCrawl } from '../../src/capture/crawl.js';
const origin = 'https://canvas.lms.unimelb.edu.au';
// Synthetic rendered DOM substitute; no course data or browser is used.
function hrefs(html: string): string[] { return [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]); }
it('start condition accepts only Canvas courses and fixes scheme/host/port', () => {
  expect(crawlOrigin(`${origin}:8443/courses/91001?x=1`)).toBe(`${origin}:8443`);
  for (const url of [`${origin}/`, `${origin}/courses-other`, 'https://ed.example/courses', 'bad']) expect(crawlOrigin(url)).toBeUndefined();
});
it('resolves rendered links, strips query/fragment, deduplicates ids and preserves page order', () => {
  const html = `<a href="/courses/91002/?term=old#x"></a><a href="/courses/91001"></a><a href="/courses/91002"></a><a href="https://other.example/courses/91003"></a><a href="/courses/abc"></a><a href="/courses/91004/assignments"></a>`;
  expect(courseLinks(hrefs(html), `${origin}/courses`)).toEqual(['91002', '91001']);
  expect(fixedPages(origin, ['91002', '91001'])).toEqual(['91002', '91001'].flatMap(id => ['assignments', 'announcements', 'grades', 'assignments/syllabus'].map(path => `${origin}/courses/${id}/${path}`)));
});
it('only follows same-origin assignment and announcement details for this course', () => {
  const html = `<a href="assignments/81001?x=1#part"></a><a href="/courses/91001/assignments/81001/"></a><a href="/courses/91002/assignments/81002"></a><a href="//other.example/courses/91001/assignments/81003"></a><a href="/courses/91001/discussion_topics/71001"></a>`;
  expect(detailLinks(hrefs(html), `${origin}/courses/91001/assignments`, '91001', 'assignments')).toEqual([`${origin}/courses/91001/assignments/81001`]);
  expect(detailLinks(hrefs(html), `${origin}/courses/91001/announcements`, '91001', 'discussion_topics')).toEqual([`${origin}/courses/91001/discussion_topics/71001`]);
});
it('detects another origin or login prefix, including ports and schemes', () => {
  for (const url of ['https://sso.example/signin', `${origin}/login/saml`, `${origin}/login`, `${origin}:8443/courses`, origin.replace('https:', 'http:')]) expect(isSignedOut(url, origin)).toBe(true);
  expect(isSignedOut(`${origin}/courses/91001`, origin)).toBe(false);
  expect(CRAWL_CAP).toBe(300);
});

function fixture(config: { links?: Record<string, string[]>; fail?: Record<string, string>; statuses?: Record<string, number>; redirect?: Record<string, string>; idle?: string } = {}) {
  let time = Date.parse('2026-10-11T10:08:17Z'); let url = `${origin}/courses`; const starts: number[] = []; const ends: number[] = [];
  const page = {
    url: () => url,
    goto: vi.fn(async (target: string, options: unknown) => {
      expect(options).toEqual({ waitUntil: 'load', timeout: 30000 }); starts.push(time); time += 25;
      url = config.redirect?.[target] ?? target;
      if (config.fail?.[target]) throw new Error(config.fail[target]);
      return { status: () => config.statuses?.[target] ?? 200 };
    }),
    waitForLoadState: vi.fn(async () => { time += 10; if (config.idle) throw Object.assign(new Error('idle'), { name: config.idle }); }),
    evaluate: vi.fn(async () => config.links?.[url] ?? []),
    close: vi.fn(async () => {}),
  };
  const context = { openHiddenPage: vi.fn(async () => page) };
  const save = vi.fn(async () => { time += 50; ends.push(time); return '/synthetic/snapshot'; });
  const writeSummary = vi.fn(async () => {}); const log = vi.fn();
  const options = { save, clock: { now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }) }, writeSummary, log };
  return { page, context, starts, ends, options, writeSummary, log, save };
}
it('crawls fixed pages for all courses before details, with hidden tab and snapshot-inclusive spacing', async () => {
  const f = fixture({ links: {
    [`${origin}/courses`]: ['/courses/91001', '/courses/91002'],
    [`${origin}/courses/91001/assignments`]: ['/courses/91001/assignments/81001?x=1'],
    [`${origin}/courses/91002/announcements`]: ['/courses/91002/discussion_topics/71002#x'],
  } });
  const summary = await runCrawl(f.context, `${origin}/courses/91001`, f.options);
  expect(f.page.goto.mock.calls.map(call => call[0])).toEqual([`${origin}/courses`, ...fixedPages(origin, ['91001', '91002']), `${origin}/courses/91001/assignments/81001`, `${origin}/courses/91002/discussion_topics/71002`]);
  expect(summary).toEqual({ startedAt: '2026-10-11T10:08:17.000Z', durationMs: 10935, saved: 11, failed: 0, status: 'completed', failedUrls: [] });
  f.starts.slice(1).forEach((start, i) => expect(start - f.ends[i]).toBeGreaterThanOrEqual(1000));
  expect(f.context.openHiddenPage).toHaveBeenCalledOnce(); expect(f.page.close).toHaveBeenCalledOnce(); expect(f.writeSummary).toHaveBeenCalledWith(summary);
});
it.each(['navigation error', 'TimeoutError'])('failed courses load %s completes with no snapshot or retry', async error => {
  const f = fixture({ fail: { [`${origin}/courses`]: error } });
  const result = await runCrawl(f.context, `${origin}/courses`, f.options);
  expect(result).toMatchObject({ status: 'completed', saved: 0, failed: 1, failedUrls: [`${origin}/courses`] });
  expect(f.save).not.toHaveBeenCalled(); expect(f.page.goto).toHaveBeenCalledOnce();
});
it.each([400, 503])('HTTP %s is failed even if load fires', async status => {
  const f = fixture({ statuses: { [`${origin}/courses`]: status } });
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ failed: 1, saved: 0, status: 'completed' });
});
it('saves after networkidle timeout only, and completes when no course is listed', async () => {
  const f = fixture({ idle: 'TimeoutError' });
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ saved: 1, failed: 0, status: 'completed' });
  expect(f.page.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 29975 });
});
it('other readiness errors fail without a snapshot', async () => {
  const f = fixture({ idle: 'Error' });
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ saved: 0, failed: 1 });
});
it.each(['https://sso.example/signin', `${origin}/login/saml`])('signed out at %s stops, keeps earlier snapshots and prompts sign-in', async target => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] }, redirect: { [`${origin}/courses/91001/assignments`]: target } });
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ status: 'signedOut', saved: 1 });
  expect(f.page.goto).toHaveBeenCalledTimes(2); expect(f.log.mock.calls.flat().join(' ')).toMatch(/sign in again/i);
});
it('stops at 300 attempts including failures', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: Array.from({ length: 100 }, (_, i) => `/courses/${91000 + i}`) }, statuses: { [`${origin}/courses/91000/assignments`]: 500 } });
  const result = await runCrawl(f.context, `${origin}/courses`, f.options);
  expect(result).toMatchObject({ status: 'capReached', saved: 299, failed: 1 }); expect(f.page.goto).toHaveBeenCalledTimes(300);
});
it('abort during current load waits for its snapshot and then closes tab and writes summary', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } }); const controller = new AbortController();
  f.save.mockImplementationOnce(async () => { controller.abort(); return '/synthetic/snapshot'; });
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal });
  expect(result).toMatchObject({ status: 'aborted', saved: 1 }); expect(f.page.goto).toHaveBeenCalledOnce(); expect(f.page.close).toHaveBeenCalledOnce();
});
it('invalid start does not create a tab or summary', async () => {
  const f = fixture(); expect(await runCrawl(f.context, 'https://ed.example/courses', f.options)).toBeUndefined();
  expect(f.context.openHiddenPage).not.toHaveBeenCalled(); expect(f.writeSummary).not.toHaveBeenCalled(); expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/open a Canvas course page/i));
});

it('abort after saving does not read a tab that has just closed', async () => {
  const f = fixture(); const controller = new AbortController();
  f.save.mockImplementationOnce(async () => { controller.abort(); return '/synthetic/snapshot'; });
  f.page.evaluate.mockImplementationOnce(async () => { if (controller.signal.aborted) throw new Error('tab closed'); return []; });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal })).toMatchObject({ saved: 1, status: 'aborted' });
  expect(f.page.evaluate).toHaveBeenCalledOnce();
});
it('aborting during the spacing interval never starts another load', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } }); const controller = new AbortController();
  f.options.clock.sleep.mockImplementationOnce(async () => { controller.abort(); });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal })).toMatchObject({ saved: 1, status: 'aborted' });
  expect(f.page.goto).toHaveBeenCalledOnce();
});
it('snapshot failure counts as a failed URL with no retry', async () => {
  const f = fixture(); f.save.mockRejectedValueOnce(new Error('write failed'));
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ saved: 0, failed: 1, failedUrls: [`${origin}/courses`] });
  expect(f.page.goto).toHaveBeenCalledOnce();
});
it('DOM read failure is reported and remaining fixed pages continue', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } });
  f.page.evaluate.mockResolvedValueOnce(['/courses/91001']).mockRejectedValueOnce(new Error('DOM unavailable'));
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ saved: 4, failed: 1, failedUrls: [`${origin}/courses/91001/assignments`], status: 'completed' });
  expect(f.page.goto).toHaveBeenCalledTimes(5);
});
it('browser close during hidden-tab creation writes aborted instead of completed', async () => {
  const f = fixture(); const controller = new AbortController();
  f.context.openHiddenPage.mockImplementationOnce(async () => { controller.abort(); throw new Error('browser closed'); });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal })).toMatchObject({ saved: 0, failed: 0, status: 'aborted' });
  expect(f.writeSummary).toHaveBeenCalledWith(expect.objectContaining({ status: 'aborted' }));
});
