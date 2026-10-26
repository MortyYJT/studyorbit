import { expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { ShellStore, attention, emptyStore, fieldName, selectionRows, settingsFromForm } from '../../web/src/shell.js';
const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const page = { items: [], evidence: [], coverage: { complete: true, gaps: [] } };
const settings = { timeZone: 'Australia/Melbourne', weekdayMinutes: [60, 120, 0, 0, 0, 0, 0], teachingWeekAnchor: '2026-01-05', breakWeeks: [3] };
function fixture(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const command = String(url).slice(5);
    const data = { 'courses.list': page, 'tasks.list': page,
      'sync.status': { running: false, blocked: [], undecided: 0, courses: [] }, 'planning.settings.read': { settings }, 'audit.list': page, ...overrides }[command];
    return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: true, data, meta }));
  });
}
it('Sign-in expired: an Ed blocked by the last run is the only sign-in item; empty, failed and incomplete reads are distinguished', async () => {
  const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': { running: false, lastRun: { id: 'run-1', startedAt: '2026-10-24T00:00:00Z',
    endedAt: '2026-10-24T00:05:00Z', outcome: 'PARTIAL', turns: 4, steps: 6 }, blocked: ['ed'], undecided: 0, courses: [] } })));
  expect(emptyStore(store.getSnapshot())).toBe(false);
  await store.refresh();
  expect(attention(store.getSnapshot()).filter(item => 'site' in item)).toEqual([{ site: 'ed', kind: 'blocked' }]);
  expect(emptyStore(store.getSnapshot())).toBe(true);
  const incomplete = new ShellStore(createClient(undefined, fixture({ 'courses.list': { ...page, coverage: { complete: false, gaps: [{ code: 'INCOMPLETE' }] } } })));
  await incomplete.refresh();
  expect(emptyStore(incomplete.getSnapshot())).toBe(false);
});
it('keeps syncing disabled until the run settles and then reloads provider status', async () => {
  let finish!: (value: Response) => void;
  const normal = fixture();
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => String(url) === '/api/sync.run'
    ? new Promise<Response>(resolve => { finish = resolve; }) : normal(url));
  const store = new ShellStore(createClient('a'.repeat(64), fetcher));
  await store.refresh();
  const run = store.sync();
  expect(store.getSnapshot().syncing).toBe(true);
  await store.sync();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/sync.run')).toHaveLength(1);
  finish(new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command: 'sync.run', ok: false,
    error: { code: 'AUTH_EXPIRED', message: 'Sign in again.', retryable: false }, meta }), { status: 401 }));
  await run;
  expect(store.getSnapshot().syncing).toBe(false);
  expect(store.getSnapshot().errors.action).toBe('AUTH_EXPIRED');
  expect(normal.mock.calls.filter(([url]) => url === '/api/sync.status')).toHaveLength(2);
});
it('preserves existing teaching settings and validates explicitly entered weekday hours', () => {
  expect(settingsFromForm(settings, ['4.1', '8.3', '0', '0', '0', '0', '0'], 'UTC', '', '')).toEqual({ ...settings, timeZone: 'UTC', weekdayMinutes: [246, 498, 0, 0, 0, 0, 0] });
  expect(() => settingsFromForm(undefined, ['', '2', '0', '0', '0', '0', '0'], 'UTC', '2026-01-05', '')).toThrow();
  expect(() => settingsFromForm(undefined, ['1', '2', '0', '0', '0', '0', '0'], 'UTC', '', '')).toThrow();
});
it('loads successive audit pages through the registry without losing earlier records', async () => {
  const row = { id: meta.runId, runId: meta.runId, command: 'synthetic', phase: 'intent', at: '2026-01-01T00:00:00Z', code: 'OK' };
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { cursor } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command: 'audit.list', ok: true,
      data: { ...page, items: [row], ...(cursor ? {} : { nextCursor: 'next' }) }, meta }));
  });
  const store = new ShellStore(createClient(undefined, fetcher));
  await store.loadAudit();
  await store.loadAudit(true);
  expect(store.getSnapshot().audit?.items).toHaveLength(2);
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ cursor: 'next' });
});
const candidate = (code: string, selected?: boolean) => ({ key: `${code}:2026:S2`, code, term: '2026:S2', name: `Synthetic ${code}`, pages: {},
  offeredAt: '2026-10-24T00:00:00Z', ...(selected === undefined ? {} : { selected, decidedAt: '2026-10-24T00:00:00Z' }) });
const lastRun = (outcome: string) => ({ id: 'run-1', startedAt: '2026-10-24T00:00:00Z', endedAt: '2026-10-24T00:05:00Z', outcome, turns: 9, steps: 14 });
it('derives needs-you items from the agent sync status: selection, blocked sign-in, unknown fields, weight warnings and policy changes', async () => {
  const course = (id: string, code: string, extra = {}) => ({ id, moduleId: 'm', code, name: code, term: '2026:S2', assessmentsComplete: false, ...extra });
  const status = { running: false, lastRun: lastRun('NEEDS_SELECTION'), blocked: ['canvas'], undecided: 3, courses: [
    { key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', courseId: 'c-a', storedAt: '2026-10-24T00:04:00Z',
      lastRun: { stored: true, unknownFields: ['components[1].items[0].due', 'course.name'], dropped: ['components[2]'], warnings: ['WEIGHT_SUM'], weightSum: 90, policyChanged: false } },
    { key: 'SYNB20002:2026:S2', code: 'SYNB20002', term: '2026:S2', courseId: 'c-b', storedAt: '2026-10-24T00:04:30Z',
      lastRun: { stored: true, unknownFields: [], dropped: [], warnings: ['REMAINDER_SHORTFALL'], policyChanged: true } },
    { key: 'SYNC30003:2026:S2', code: 'SYNC30003', term: '2026:S2', lastRun: { stored: false, unknownFields: [], dropped: [], warnings: [], policyChanged: false } },
    { key: 'SYND40004:2026:S2', code: 'SYND40004', term: '2026:S2', courseId: 'c-d', storedAt: '2026-10-20T00:00:00Z' },
  ] };
  const courses = { ...page, items: [course('c-a', 'SYNA10001'), course('c-b', 'SYNB20002', { aiPolicy: 'prohibited',
    readState: { aiPolicy: { state: 'found', quote: 'Generative AI is not permitted.' } } })] };
  const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': status, 'courses.list': courses, })));
  await store.refresh();
  expect(attention(store.getSnapshot())).toEqual([
    { kind: 'select', count: 3 },
    { site: 'canvas', kind: 'blocked' },
    { kind: 'unknown', course: 'SYNA10001', courseId: 'c-a', fields: ['components[1].items[0].due', 'course.name'], dropped: ['components[2]'] },
    { kind: 'weights', course: 'SYNA10001', courseId: 'c-a', warning: 'WEIGHT_SUM', sum: 90 },
    { kind: 'weights', course: 'SYNB20002', courseId: 'c-b', warning: 'REMAINDER_SHORTFALL' },
    { kind: 'policy', course: 'SYNB20002', courseId: 'c-b', value: 'prohibited', quote: 'Generative AI is not permitted.' },
    { kind: 'unread', course: 'SYNC30003' },
  ]);
});
it('reports a failed run once, but not when every platform was blocked (the blocked items say what to do)', async () => {
  const read = async (status: object) => {
    const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': { running: false, blocked: [], undecided: 0, courses: [], ...status }, })));
    await store.refresh();
    return attention(store.getSnapshot());
  };
  expect(await read({ lastRun: lastRun('TIMEOUT') })).toEqual([{ kind: 'failed', outcome: 'TIMEOUT' }]);
  expect(await read({ lastRun: lastRun('AGENT_UNAVAILABLE') })).toEqual([{ kind: 'failed', outcome: 'AGENT_UNAVAILABLE' }]);
  expect(await read({ lastRun: lastRun('AGENT_UNAVAILABLE'), blocked: ['canvas', 'ed'] })).toEqual([{ site: 'canvas', kind: 'blocked' }, { site: 'ed', kind: 'blocked' }]);
});
it('names unknown field paths readably in both languages', async () => {
  const { en, zh } = await import('../../web/src/i18n.js');
  expect(fieldName('components[1].items[0].due', en)).toBe('component 2 · item 1 · due date');
  expect(fieldName('components[0].weight', en)).toBe('component 1 · weight');
  expect(fieldName('course.name', en)).toBe('course · name');
  expect(fieldName('components[1].items[0].due', zh)).toBe('第 2 个分数构成 · 第 1 项 · 截止时间');
  expect(fieldName('course.mystery', en)).toBe('course · mystery');
});
it('lists candidates undecided first and records the ticked selection through the owner session (scenario "Choose courses")', async () => {
  const items = [candidate('SYNA10001', true), candidate('SYNB20002'), candidate('SYNC30003'), candidate('SYND40004'), candidate('SYNE50005', false)];
  const rows = selectionRows(items);
  expect(rows.map(row => [row.code, row.undecided, row.checked])).toEqual([
    ['SYNB20002', true, false], ['SYNC30003', true, false], ['SYND40004', true, false], ['SYNA10001', false, true], ['SYNE50005', false, false]]);
  const secret = 'b'.repeat(64);
  const normal = fixture({ 'courses.candidates': { items }, 'courses.select': { recorded: 5 } });
  const anonymous = new ShellStore(createClient(undefined, normal));
  expect(await anonymous.selectCourses(rows, new Set(['SYNB20002:2026:S2']))).toBe(false);
  expect(anonymous.getSnapshot().errors.select).toBe('OWNER_SESSION_EXPIRED');
  expect(normal).not.toHaveBeenCalled();
  const store = new ShellStore(createClient(secret, normal));
  await store.loadCandidates();
  expect(store.getSnapshot().candidates).toHaveLength(5);
  // Ticks B and C, leaves D unticked, unticks A; E stays unticked as recorded.
  expect(await store.selectCourses(rows, new Set(['SYNB20002:2026:S2', 'SYNC30003:2026:S2']))).toBe(true);
  const call = normal.mock.calls.find(([url]) => url === '/api/courses.select')! as unknown as [string, RequestInit];
  expect(call[1].headers).toMatchObject({ 'X-Coursework-Session': secret });
  // Only undecided and changed rows are sent: unchanged decisions need no write.
  expect(JSON.parse(String(call[1].body))).toEqual({ selections: [
    { key: 'SYNB20002:2026:S2', selected: true }, { key: 'SYNC30003:2026:S2', selected: true }, { key: 'SYND40004:2026:S2', selected: false },
    { key: 'SYNA10001:2026:S2', selected: false }] });
  // Saving re-reads the status and the candidates so "needs you" drops the item.
  expect(normal.mock.calls.filter(([url]) => url === '/api/sync.status')).toHaveLength(1);
  expect(normal.mock.calls.filter(([url]) => url === '/api/courses.candidates')).toHaveLength(2);
});
it('sends more than 100 changes in batches the contract accepts', async () => {
  const items = Array.from({ length: 150 }, (_, index) => candidate(`SYNA${String(10000 + index)}`));
  const normal = fixture({ 'courses.candidates': { items }, 'courses.select': { recorded: 1 } });
  const store = new ShellStore(createClient('c'.repeat(64), normal));
  expect(await store.selectCourses(selectionRows(items), new Set([items[0]!.key]))).toBe(true);
  const sizes = normal.mock.calls.filter(([url]) => url === '/api/courses.select')
    .map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).selections.length);
  expect(sizes).toEqual([100, 50]);
});
it('offers course selection after a NEEDS_SELECTION run even when nothing is undecided', async () => {
  const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': { running: false, lastRun: lastRun('NEEDS_SELECTION'), blocked: [], undecided: 0, courses: [] }, })));
  await store.refresh();
  expect(attention(store.getSnapshot())).toEqual([{ kind: 'select', count: 0 }]);
});
it('drops the selection entry once courses are selected, even before the next run', async () => {
  const chosen = { key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2' };
  const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': { running: false, lastRun: lastRun('NEEDS_SELECTION'), blocked: [], undecided: 0, courses: [chosen] }, })));
  await store.refresh();
  expect(attention(store.getSnapshot())).toEqual([]);
});
it('lists no per-course "not read" lines when the whole run was blocked', async () => {
  const unread = (code: string) => ({ key: `${code}:2026:S2`, code, term: '2026:S2', lastRun: { stored: false, unknownFields: [], dropped: [], warnings: [], policyChanged: false } });
  const read = async (outcome: string, blocked: string[]) => {
    const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': { running: false, lastRun: lastRun(outcome), blocked, undecided: 0,
      courses: [unread('SYNA10001'), unread('SYNB20002')] } })));
    await store.refresh();
    return attention(store.getSnapshot()).map(item => item.kind);
  };
  expect(await read('AGENT_UNAVAILABLE', ['canvas', 'ed'])).toEqual(['blocked', 'blocked']);
  expect(await read('PARTIAL', ['canvas', 'ed'])).toEqual(['blocked', 'blocked']);
  expect(await read('PARTIAL', ['ed'])).toEqual(['blocked', 'unread', 'unread']);
});
it('reports a course whose last run could not download files, but keeps clean and older runs quiet', async () => {
  const read = async (missingFiles?: number) => {
    const status = { running: false, blocked: [], undecided: 0, courses: [{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', courseId: 'c-a',
      lastRun: { stored: true, unknownFields: [], dropped: [], warnings: [], policyChanged: false, ...(missingFiles === undefined ? {} : { missingFiles }) } }] };
    const store = new ShellStore(createClient(undefined, fixture({ 'sync.status': status })));
    await store.refresh();
    return attention(store.getSnapshot());
  };
  expect(await read(3)).toEqual([{ kind: 'missing', course: 'SYNA10001', courseId: 'c-a', count: 3 }]);
  expect(await read(0)).toEqual([]);
  expect(await read()).toEqual([]);
});
