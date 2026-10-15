import { expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { ShellStore, attention, emptyStore, settingsFromForm } from '../../web/src/shell.js';
const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const page = { items: [], evidence: [], coverage: { complete: true, gaps: [] } };
const signedIn = { state: 'signedIn', checkedAt: '2026-01-01T00:00:00Z' };
const settings = { timeZone: 'Australia/Melbourne', weekdayMinutes: [60, 120, 0, 0, 0, 0, 0], teachingWeekAnchor: '2026-01-05', breakWeeks: [3] };
function fixture(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const command = String(url).slice(5);
    const data = { 'courses.list': page, 'tasks.list': page, 'browser.status': { canvas: signedIn, ed: { ...signedIn, state: 'signedOut' } },
      'sync.status': { running: false, canvas: {}, ed: {} }, 'planning.settings.read': { settings }, 'audit.list': page, ...overrides }[command];
    return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: true, data, meta }));
  });
}
it('shows Ed expiry as needs-you and distinguishes empty, failed, and incomplete reads', async () => {
  const store = new ShellStore(createClient(undefined, fixture()));
  expect(emptyStore(store.getSnapshot())).toBe(false);
  await store.refresh();
  expect(attention(store.getSnapshot())).toContainEqual({ site: 'ed', kind: 'signin' });
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
