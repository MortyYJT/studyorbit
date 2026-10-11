import { it, expect, vi } from 'vitest';
import { discoverCanvas, discoverEd, type DiscoveryPage } from '../../src/capture/discovery-adapters.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
const limiter = () => { let time = 0; return new RequestLimiter({ now: () => time, sleep: async ms => { time += ms; } }); };
it('filters reflected credentials before discovery courses cross the page boundary or reach snapshots', async () => {
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-secret' });
  vi.stubGlobal('fetch', async () => ({ status: 200, ok: true, json: async () => ({
    user: 'private-profile', courses: [{ course: { id: 42, code: 'SYN10001', name: 'Course synthetic-secret',
      year: 2026, session: 'Synthetic', status: 'active', headers: { 'x-token': 'synthetic-secret' } } }],
  }) }));
  const crossed: unknown[] = []; const snapshot = vi.fn(async () => {});
  const page = { url: () => 'https://edstem.org/au/', goto: vi.fn(),
    evaluate: async (expression: string | (() => unknown)) => {
      const result = await (typeof expression === 'string' ? Function(`return ${expression}`)() : expression());
      crossed.push(result); return result;
    } };
  try {
    const result = await discoverEd(page as DiscoveryPage, limiter(), { snapshot });
    expect(JSON.stringify(crossed)).not.toMatch(/synthetic-secret|x-token|private-profile/);
    expect(result).toMatchObject({ status: 'available', courses: [{ name: 'Course [withheld]' }] });
    expect(snapshot).toHaveBeenCalledWith([{ course: { id: 42, code: 'SYN10001', name: 'Course [withheld]', year: 2026, session: 'Synthetic', status: 'active' } }]);
  } finally { vi.unstubAllGlobals(); }
});
it('discovers Canvas only from current table including community/default terms', async () => {
  const evaluate = vi.fn(async () => [{ id: '42', name: 'Community', term: '默认学期' }]);
  const goto = vi.fn(async () => ({ status: () => 200 }));
  const budget = limiter();
  const result = await discoverCanvas({ goto, url: () => 'https://canvas.lms.unimelb.edu.au/courses', evaluate } as unknown as DiscoveryPage, budget);
  expect(result.status).toBe('available'); expect(budget.attempts).toBe(1);
  expect(String(evaluate.mock.calls[0])).toContain('my_courses_table');
  expect(goto).toHaveBeenCalledWith('https://canvas.lms.unimelb.edu.au/courses', expect.anything());
});
it('keeps token inside page and returns/snapshots only courses', async () => {
  const previous = { location: globalThis.location, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'synthetic-token') });
  const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ courses: [], user: 'private', push_key: 'private', push_subscriptions: ['private'] }) }));
  vi.stubGlobal('fetch', fetch);
  try {
    const snapshot = vi.fn(async () => {}); const budget = limiter();
    const page = { url: () => 'https://edstem.org/au/dashboard', goto: vi.fn(), evaluate: async (expression: string | (() => unknown)) => typeof expression === 'string' ? Function(`return ${expression}`)() : expression() };
    const result = await discoverEd(page as unknown as DiscoveryPage, budget, { snapshot });
    expect(result.status).toBe('available'); expect(snapshot).toHaveBeenCalledWith([]);
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(fetch).toHaveBeenCalledWith('/api/user', { method: 'GET', headers: { 'x-token': 'synthetic-token' }, credentials: 'same-origin', redirect: 'error' });
    expect(localStorage.getItem).toHaveBeenCalledWith('authToken:au');
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(await discoverEd(page as unknown as DiscoveryPage, budget)).toMatchObject({ status: 'unavailable', error: { code: 'AUTH_EXPIRED' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { for (const [key, value] of Object.entries(previous)) vi.stubGlobal(key, value); }
});
it('bootstraps Ed within same budget and rejects redirects/errors without raw diagnostics', async () => {
  const page = { url: () => 'about:blank', route: vi.fn(), unroute: vi.fn(), goto: vi.fn(async () => {}), evaluate: vi.fn(async () => ({ kind: 'unavailable' })) };
  const budget = limiter();
  expect((await discoverEd(page as unknown as DiscoveryPage, budget)).status).toBe('unavailable'); expect(budget.attempts).toBe(1);
  expect(await discoverCanvas({ ...page, url: () => 'https://other.invalid/courses' } as unknown as DiscoveryPage, budget)).toMatchObject({ status: 'unavailable' });
});
// Synthetic DOM cells preserve hidden text until a cloned screenreader node is removed.
function cell(visible: string, hidden = '') {
  return { textContent: visible + hidden, cloneNode: () => {
    let text = visible + hidden;
    return { get textContent() { return text; }, querySelectorAll: (selector: string) => {
      expect(selector).toBe('.screenreader-only');
      return hidden ? [{ remove: () => { text = visible; } }] : [];
    } };
  } };
}
function canvasRow(id: string, name: string, term: string, unpublished = false) {
  const title = { ...cell(name, ' Accessible title helper'), tagName: id ? 'TD' : 'TH',
    querySelector: (selector: string) => selector === 'a[href]' && id ? { getAttribute: () => `/courses/${id}` }
      : selector === 'span.name' ? cell(name) : null };
  return { classList: { contains: (name: string) => unpublished && name === 'course-list-unpublished-course-row' },
    querySelector: (selector: string) => selector === '.course-list-course-title-column'
      ? title : selector === '.course-list-term-column' ? cell(term, ' Accessible term helper')
      : selector === '.course-list-star-column' ? { querySelector: () => ({ getAttribute: () => '99' }) }
      : selector === '.course-list-published-column' ? cell('Students cannot access this course.') : null };
}
it('executes the Canvas selector and skips unpublished/linkless rows without hidden text', async () => {
  const rows = [canvasRow('42', 'ABCD10001', '2026 Semester 2'), canvasRow('43', 'Community', 'Course Term'),
    canvasRow('', 'Unpublished', '2026 Semester 2', true), canvasRow('', 'Linkless', 'Course Term'),
    canvasRow('44', 'Unpublished with link', 'Course Term', true)];
  const previous = globalThis.document;
  vi.stubGlobal('document', { querySelector: (selector: string) => {
    expect(selector).toBe('table#my_courses_table');
    return { querySelectorAll: (s: string) => { expect(s).toBe('tr.course-list-table-row'); return rows; } };
  } });
  const page = { goto: async () => null, url: () => 'https://canvas.lms.unimelb.edu.au/courses', evaluate: async (expression: string) => Function(`return ${expression}`)() };
  try {
    expect(await discoverCanvas(page as unknown as DiscoveryPage, limiter())).toMatchObject({ status: 'available', skipped: 3,
      courses: [{ id: '42', name: 'ABCD10001', term: { label: '2026 Semester 2' } }, { id: '43', name: 'Community', term: { label: 'Course Term' } }] });
    rows.splice(0);
    expect(await discoverCanvas(page as unknown as DiscoveryPage, limiter())).toEqual({ source: 'canvas', status: 'available', skipped: 0, courses: [] });
    rows.push(canvasRow('', 'Unpublished', 'Course Term', true));
    expect(await discoverCanvas(page as unknown as DiscoveryPage, limiter())).toEqual({ source: 'canvas', status: 'available', skipped: 1, courses: [] });
    vi.stubGlobal('document', { querySelector: () => null });
    expect(await discoverCanvas(page as unknown as DiscoveryPage, limiter())).toMatchObject({ status: 'unavailable' });
  } finally { vi.stubGlobal('document', previous); }
});
it('maps Ed HTTP auth, rate limits, malformed data and redirects without retry', async () => {
  const previous = { location: globalThis.location, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  vi.stubGlobal('location', { origin: 'https://edstem.org' });
  vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token' });
  const page = { url: () => 'https://edstem.org/au/', goto: vi.fn(), evaluate: async (expression: string | (() => unknown)) => typeof expression === 'string' ? Function(`return ${expression}`)() : expression() };
  try {
    for (const status of [401, 403, 429, 404]) {
      const fetch = vi.fn(async () => ({ status, ok: false })); vi.stubGlobal('fetch', fetch);
      expect(await discoverEd(page as unknown as DiscoveryPage, limiter())).toMatchObject({ error: { code: status === 401 || status === 403 ? 'AUTH_EXPIRED' : 'SOURCE_UNAVAILABLE' } });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    vi.stubGlobal('fetch', async () => { throw Error('synthetic-token raw payload'); });
    expect(JSON.stringify(await discoverEd(page as unknown as DiscoveryPage, limiter()))).not.toContain('synthetic-token');
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ user: 'private' }) }));
    expect(await discoverEd(page as unknown as DiscoveryPage, limiter())).toMatchObject({ status: 'unavailable' });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('location', { origin: 'https://other.invalid' });
    expect(await discoverEd(page as unknown as DiscoveryPage, limiter())).toMatchObject({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  } finally { for (const [key, value] of Object.entries(previous)) vi.stubGlobal(key, value); }
});
