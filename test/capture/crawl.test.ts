import { expect, it, vi } from 'vitest';
import { crawlOrigin, courseLinks, detailLinks, fixedPages, isSignedOut, CRAWL_CAP, runCrawl } from '../../src/capture/crawl.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
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

function fixture(config: { links?: Record<string, string[]>; fail?: Record<string, string>; statuses?: Record<string, number>; redirect?: Record<string, string>; idle?: string; uncommitted?: boolean } = {}) {
  let time = Date.parse('2026-10-11T10:08:17Z'); let url = 'about:blank'; const starts: number[] = []; const ends: number[] = [];
  const page = {
    url: () => url,
    goto: vi.fn(async (target: string, options: unknown) => {
      expect(options).toEqual({ waitUntil: 'load', timeout: 30000 }); starts.push(time); time += 25;
      if (!config.uncommitted) url = config.redirect?.[target] ?? target;
      if (config.fail?.[target]) throw new Error(config.fail[target]);
      return { status: () => config.statuses?.[target] ?? 200 };
    }),
    waitForLoadState: vi.fn(async () => { time += 10; if (config.idle) throw Object.assign(new Error('idle'), { name: config.idle }); }),
    evaluate: vi.fn(async () => url === `${origin}/courses` ? courseLinks(config.links?.[url] ?? [], url).map(id => ({ id, name: 'Synthetic course', term: 'Synthetic term', unpublished: false })) : config.links?.[url] ?? []),
    close: vi.fn(async () => {}),
  };
  const context = { openHiddenPage: vi.fn(async () => page) };
  const save = vi.fn(async () => { time += 50; ends.push(time); return '/synthetic/snapshot'; });
  const writeSummary = vi.fn(async () => {}); const log = vi.fn();
  const selection = { version: 1 as const, courses: Array.from({ length: 100 }, (_, i) => ({ source: 'canvas' as const, origin, id: String(91000 + i), term: { label: 'Synthetic term' } })) };
  const options = { selection, save, clock: { now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }) }, writeSummary, log };
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
  expect(summary).toMatchObject({ startedAt: '2026-10-11T10:08:17.000Z', durationMs: 10935, saved: 11, failed: 0, status: 'completed', failedUrls: [] });
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
  f.page.evaluate.mockResolvedValueOnce([{ id: '91001', name: 'Synthetic course', term: 'Synthetic term', unpublished: false }]).mockRejectedValueOnce(new Error('DOM unavailable'));
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ saved: 4, failed: 1, failedUrls: [`${origin}/courses/91001/assignments`], status: 'completed' });
  expect(f.page.goto).toHaveBeenCalledTimes(5);
});
it('browser close during hidden-tab creation writes aborted instead of completed', async () => {
  const f = fixture(); const controller = new AbortController();
  f.context.openHiddenPage.mockImplementationOnce(async () => { controller.abort(); throw new Error('browser closed'); });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal })).toMatchObject({ saved: 0, failed: 0, status: 'aborted' });
  expect(f.writeSummary).toHaveBeenCalledWith(expect.objectContaining({ status: 'aborted' }));
});

it.each(['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED'])('uncommitted first navigation %s counts as a failure without requesting sign-in', async error => {
  const f = fixture({ uncommitted: true, fail: { [`${origin}/courses`]: error } });
  const result = await runCrawl(f.context, `${origin}/courses`, f.options);
  expect(result).toMatchObject({ status: 'completed', saved: 0, failed: 1, failedUrls: [`${origin}/courses`] });
  expect(f.page.goto).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled();
  expect(f.writeSummary).toHaveBeenCalledWith(result);
  expect(f.log.mock.calls.flat().join(' ')).not.toMatch(/sign in again/i);
});
it.each(['https://sso.example/signin', `${origin}/login/saml`])('committed redirect to %s still signs out when navigation throws', async target => {
  const f = fixture({ redirect: { [`${origin}/courses`]: target }, fail: { [`${origin}/courses`]: 'navigation failed' } });
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ status: 'signedOut', saved: 0, failed: 0 });
  expect(f.save).not.toHaveBeenCalled(); expect(f.page.goto).toHaveBeenCalledOnce();
});
it.each(['redirect', 'redirect error', 'uncommitted error', 'readiness redirect'])('cancellation during %s takes priority after the current load settles', async outcome => {
  const controller = new AbortController();
  const f = fixture({
    redirect: outcome === 'redirect' || outcome === 'redirect error' || outcome === 'readiness redirect' ? { [`${origin}/courses`]: `${origin}/login/saml` } : undefined,
    fail: outcome.includes('error') ? { [`${origin}/courses`]: 'navigation failed' } : undefined,
    uncommitted: outcome === 'uncommitted error',
  });
  if (outcome === 'readiness redirect') {
    let ready = false;
    f.page.url = () => ready ? `${origin}/login/saml` : `${origin}/courses`;
    f.page.waitForLoadState.mockImplementationOnce(async () => { controller.abort(); ready = true; });
  } else {
    const navigate = f.page.goto.getMockImplementation()!;
    f.page.goto.mockImplementationOnce(async (target, options) => { controller.abort(); return navigate(target, options); });
  }
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal });
  expect(result).toMatchObject({ status: 'aborted', saved: 0, failed: outcome === 'uncommitted error' ? 1 : 0,
    failedUrls: outcome === 'uncommitted error' ? [`${origin}/courses`] : [] });
  expect(f.page.goto).toHaveBeenCalledOnce(); expect(f.page.close).toHaveBeenCalledOnce();
  expect(f.writeSummary).toHaveBeenCalledWith(result); expect(f.save).not.toHaveBeenCalled();
  expect(f.log.mock.calls.flat().join(' ')).not.toMatch(/sign in again/i);
});

// Task 2.1: source-qualified selection and discovery reuse.
it('queues only selected Canvas courses in discovery order and reports missing ids', async () => {
  const f = fixture({ links: {
    [`${origin}/courses`]: ['/courses/91002', '/courses/91001', '/courses/91003'],
    [`${origin}/courses/91001/assignments`]: ['/courses/91001/assignments/81001', '/courses/91003/assignments/81002'],
  } });
  const courses = f.options.selection.courses.filter(c => ['91001', '91002', '91099'].includes(c.id));
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options, selection: { version: 1, courses: [
    ...courses, { source: 'ed', origin: 'https://edstem.org', id: '91003', term: { label: 'Synthetic', year: 2026, session: 'S2' } },
  ] } });
  expect(f.page.goto.mock.calls.map(c => c[0])).toEqual([`${origin}/courses`, ...fixedPages(origin, ['91002', '91001']), `${origin}/courses/91001/assignments/81001`]);
  expect(result).toMatchObject({ missingIds: ['91099'] });
});
it('reuses available discovery and never refetches the listing', async () => {
  const f = fixture();
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options, discovery: {
    source: 'canvas', status: 'available', skipped: 0, courses: [{ ...f.options.selection.courses[1], name: 'Synthetic' }],
  } });
  expect(f.page.goto.mock.calls.map(c => c[0])).toEqual(fixedPages(origin, ['91001']));
  expect(result).toMatchObject({ saved: 4 });
});
it('empty selection schedules no course-specific reads', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } });
  await runCrawl(f.context, `${origin}/courses`, { ...f.options, selection: { version: 1, courses: [] } });
  expect(f.page.goto.mock.calls.map(c => c[0])).toEqual([`${origin}/courses`]);
});
// Task 2.2: final URL deduplication and redirect identity.
it('discovers announcement details on the own-identity visit even when a redirect saved its snapshot', async () => {
  const home = `${origin}/courses/101`;
  const announcements = `${home}/announcements`;
  const detail = `${home}/discussion_topics/501`;
  const f = fixture({ links: { [announcements]: [detail, `${home}/assignments/601`] },
    redirect: { [`${home}/assignments`]: announcements } });
  const course = { source: 'canvas' as const, origin, id: '101', term: { label: 'Synthetic term' } };
  const saved: string[] = [];
  f.save.mockImplementation(async () => { saved.push(f.page.url()); return '/synthetic/snapshot'; });
  const limiter = new RequestLimiter(f.options.clock);
  const result = await runCrawl(f.context, home, { ...f.options, limiter,
    selection: { version: 1, courses: [course] },
    discovery: { source: 'canvas', status: 'available', skipped: 0, courses: [{ ...course, name: 'Synthetic' }] },
  });
  expect(f.page.goto.mock.calls.map(call => call[0])).toEqual([...fixedPages(origin, ['101']), detail]);
  expect(f.page.evaluate).toHaveBeenCalledOnce(); // only the announcements visit under its own identity
  expect(saved.filter(url => url === announcements)).toHaveLength(1);
  expect(saved).toContain(detail);
  expect(result).toMatchObject({ status: 'completed', attempted: 5, saved: 4, duplicates: 1, failed: 0 });
  expect(limiter.attempts).toBe(5);
});
it('saves normalized redirected homes once per run without expanding home links', async () => {
  const home = `${origin}/courses/91001`;
  const f = fixture({ links: {
    [`${origin}/courses`]: [home],
    [`${home}/?private=synthetic#part`]: [`${home}/assignments/81001`],
  }, redirect: {
    [`${home}/assignments`]: `${home}/?private=synthetic#part`,
    [`${home}/assignments/syllabus`]: `https://synthetic:synthetic@canvas.lms.unimelb.edu.au/courses/91001#part`,
  } });
  const result = await runCrawl(f.context, `${origin}/courses`, f.options);
  expect(result).toMatchObject({ saved: 4, failed: 0, redirects: [
    { requestedUrl: `${home}/assignments`, finalUrl: home, alreadySaved: false },
    { requestedUrl: `${home}/assignments/syllabus`, finalUrl: home, alreadySaved: true },
  ] });
  expect(f.page.goto).toHaveBeenCalledTimes(5);
  expect(f.page.evaluate).toHaveBeenCalledTimes(2); // discovery and announcements, never home
  expect(f.save).toHaveBeenCalledTimes(4);
  await runCrawl(f.context, `${origin}/courses`, f.options);
  expect(f.save).toHaveBeenCalledTimes(8); // dedup state is local to each run
});
// Task 2.3: failed writes must not poison deduplication; unselected redirects stay private.
it('allows a later home save after the first redirected write fails', async () => {
  const home = `${origin}/courses/91001`;
  const f = fixture({ links: { [`${origin}/courses`]: [home] }, redirect: {
    [`${home}/assignments`]: home, [`${home}/assignments/syllabus`]: home,
  } });
  f.save.mockResolvedValueOnce('/synthetic/listing').mockRejectedValueOnce(new Error('Synthetic write failure'));
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ saved: 4, failed: 1, redirects: [
    { requestedUrl: `${home}/assignments`, finalUrl: home, alreadySaved: false },
    { requestedUrl: `${home}/assignments/syllabus`, finalUrl: home, alreadySaved: false },
  ] });
  expect(f.save).toHaveBeenCalledTimes(5);
});
it('records unselected redirects without saving or expanding them', async () => {
  const other = `${origin}/courses/91002/assignments`;
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001', '/courses/91002'], [other]: ['/courses/91002/assignments/81002'] },
    redirect: { [`${origin}/courses/91001/assignments`]: other } });
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options,
    selection: { version: 1, courses: [f.options.selection.courses[1]] } });
  expect(result).toMatchObject({ saved: 4, failed: 0, redirects: [{ requestedUrl: `${origin}/courses/91001/assignments`, finalUrl: other, alreadySaved: false }] });
  expect(f.page.evaluate).toHaveBeenCalledTimes(2);
  expect(f.save).toHaveBeenCalledTimes(4); expect(f.page.goto).toHaveBeenCalledTimes(5);
});

// Task 2.4: the injected run-wide limiter owns every navigation.
it('charges discovery, failed loads and duplicate redirects to the same limiter', async () => {
  const home = `${origin}/courses/91001`;
  const f = fixture({ links: { [`${origin}/courses`]: [home] }, redirect: {
    [`${home}/assignments`]: home, [`${home}/assignments/syllabus`]: home,
  }, statuses: { [`${home}/grades`]: 429 } });
  const limiter = new RequestLimiter(f.options.clock);
  await limiter.attempt(async () => {}); // synthetic Ed/discovery attempt
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, limiter })).toMatchObject({ saved: 3, failed: 1 });
  expect(limiter.attempts).toBe(6); expect(f.page.goto).toHaveBeenCalledTimes(5);
  expect(f.starts[0]).toBeGreaterThanOrEqual(Date.parse('2026-10-11T10:08:18Z'));
});
it('never starts navigation number 301 after another provider consumes the budget', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } });
  const limiter = new RequestLimiter(f.options.clock);
  for (let i = 0; i < 299; i++) await limiter.attempt(async () => {});
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, limiter })).toMatchObject({ status: 'capReached', saved: 1 });
  expect(limiter.attempts).toBe(300); expect(f.page.goto).toHaveBeenCalledOnce();
});
it('counts the in-flight cancelled attempt and waits for its write before closing', async () => {
  const f = fixture(); const controller = new AbortController();
  const limiter = new RequestLimiter(f.options.clock);
  f.save.mockImplementationOnce(async () => { controller.abort(); return '/synthetic/snapshot'; });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, limiter, signal: controller.signal })).toMatchObject({ status: 'aborted', saved: 1 });
  expect(limiter.attempts).toBe(1); expect(f.page.close).toHaveBeenCalledOnce();
});
it('cancelled spacing consumes no additional attempt', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } }); const controller = new AbortController();
  const limiter = new RequestLimiter(f.options.clock);
  f.options.clock.sleep.mockImplementationOnce(async () => { controller.abort(); });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, limiter, signal: controller.signal })).toMatchObject({ status: 'aborted' });
  expect(limiter.attempts).toBe(1); expect(f.page.goto).toHaveBeenCalledOnce();
});
// Task 2.5: bounded, content-free Canvas outcomes for orchestration.
it('returns sanitized counts, redirect pairs and coverage gaps without content or error messages', async () => {
  const home = `${origin}/courses/91001`;
  const f = fixture({ links: { [`${origin}/courses`]: [home] }, redirect: {
    [`${home}/assignments`]: `https://synthetic:synthetic@canvas.lms.unimelb.edu.au/courses/91002/?secret=synthetic#private`,
  }, statuses: { [`${home}/grades`]: 503 } });
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options, selection: { version: 1, courses: [f.options.selection.courses[1], f.options.selection.courses[99]] } });
  expect(result).toMatchObject({ source: 'canvas', attempted: 5, saved: 3, failed: 1, skipped: 1, duplicates: 0, discoveryReused: false,
    missingIds: ['91099'], gaps: [{ code: 'UNSELECTED_REDIRECT', url: `${origin}/courses/91002` }],
    redirects: [{ requestedUrl: `${home}/assignments`, finalUrl: `${origin}/courses/91002`, alreadySaved: false }],
  });
  expect(JSON.stringify(result)).not.toMatch(/secret|private|synthetic|name|html|headers|token/i);
  expect(f.log.mock.calls.flat().join(' ')).not.toMatch(/secret|private|synthetic/i);
});
it('reuses unavailable Canvas discovery as a gap without requesting courses or assuming missing ids', async () => {
  const f = fixture();
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options,
    discovery: { source: 'canvas', status: 'unavailable', error: new Error('Synthetic private body') as never } });
  expect(result).toMatchObject({ status: 'completed', attempted: 0, saved: 0, failed: 0, discoveryReused: true, missingIds: [], gaps: [{ code: 'SOURCE_UNAVAILABLE' }] });
  expect(f.page.goto).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('Synthetic private body');
});
it('records sanitized signed-out redirects including when navigation throws', async () => {
  const f = fixture({ redirect: { [`${origin}/courses`]: 'https://synthetic:synthetic@sso.example/signin?secret=synthetic#private' },
    fail: { [`${origin}/courses`]: 'Synthetic private body' } });
  expect(await runCrawl(f.context, `${origin}/courses`, f.options)).toMatchObject({ source: 'canvas', attempted: 1, status: 'signedOut', saved: 0, failed: 0,
    redirects: [{ requestedUrl: `${origin}/courses`, finalUrl: 'https://sso.example/signin', alreadySaved: false }] });
  expect(f.log.mock.calls.flat().join(' ')).not.toMatch(/synthetic|secret|private/i);
});
it('does not invent redirects for cancellation before a queued navigation starts', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } });
  const controller = new AbortController();
  f.options.clock.sleep.mockImplementationOnce(async () => { controller.abort(); });
  expect(await runCrawl(f.context, `${origin}/courses`, { ...f.options, signal: controller.signal })).toMatchObject({ attempted: 1, redirects: [], status: 'aborted' });
});
it('does not report the previous committed page as a redirect after an uncommitted failure', async () => {
  const f = fixture({ links: { [`${origin}/courses`]: ['/courses/91001'] } });
  const navigate = f.page.goto.getMockImplementation()!;
  // Reused discovery avoids the listing; grades fails without replacing the announcements page.
  f.page.goto.mockImplementation(async (target, options) => {
    if (target.endsWith('/grades')) throw new Error('Synthetic DNS failure');
    return navigate(target, options);
  });
  const result = await runCrawl(f.context, `${origin}/courses`, { ...f.options, discovery: {
    source: 'canvas', status: 'available', skipped: 0, courses: [{ ...f.options.selection.courses[1], name: 'Synthetic' }],
  } });
  expect(result).toMatchObject({ failed: 1, redirects: [] });
});
it('keeps discovery navigation on the fixed Canvas origin including its scheme and port', async () => {
  const f = fixture();
  const alternate = 'http://canvas.lms.unimelb.edu.au:8443';
  await runCrawl(f.context, `${alternate}/courses`, f.options);
  expect(f.page.goto.mock.calls.map(c => c[0])).toEqual([`${alternate}/courses`]);
});
