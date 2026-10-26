import { expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { en, zh } from '../../web/src/i18n.js';
import { ShellStore } from '../../web/src/shell.js';
import { conflictNeeds, conflictValue, needGroups, needsYou, updateNeeds, visibleNeedItems, type Need } from '../../web/src/week.js';

const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const empty = { items: [], evidence: [], coverage: { complete: true, gaps: [] } };
const secret = 'a'.repeat(64);
const at = '2026-10-24T00:00:00Z';
const weight = { id: 'conflict-weight', courseId: 'c1', target: { componentKey: 'c1:assignments' }, field: 'weight' as const,
  skeletonValue: 30, canvasValue: 40, state: 'open' as const, checkedAt: at, componentName: 'Assignments' };
const unmatched = { id: 'conflict-unmatched', courseId: 'c1', target: { canvasAssignmentId: 'canvas-1' }, field: 'unmatched' as const,
  canvasValue: { id: 'canvas-1', name: 'Synthetic unlisted reflection', due: null }, state: 'open' as const, checkedAt: at,
  canvasName: 'Synthetic unlisted reflection', components: [{ key: 'c1:assignments', name: 'Assignments' }, { key: 'c1:quizzes', name: 'Quizzes' }] };
const update = { savedFileId: 'saved-1', courseId: 'c1', assessmentId: 'a1', assessmentName: 'Synthetic Essay', name: 'instructions.html', savedAt: at };
function fixture(input: { conflicts?: () => unknown[]; updates?: () => unknown[]; onResolve?: (body: Record<string, unknown>) => void; onOpen?: (body: Record<string, unknown>) => void } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const command = String(url).slice(5);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const data: Record<string, unknown> = {
      'courses.list': empty, 'tasks.list': empty, 'audit.list': empty, 'planning.settings.read': { settings: undefined },
      'sync.status': { running: false, blocked: [], undecided: 0, courses: [] },
      'conflicts.list': { ...empty, items: input.conflicts?.() ?? [] },
      'updates.list': { ...empty, items: input.updates?.() ?? [] },
      'check.resolve': { conflict: { ...weight, state: 'resolved', choice: 'skeleton', resolvedAt: at }, choices: { weight: { 'c1:assignments': 'skeleton' }, unmatched: {} } },
      'file.open': { opened: true, openedAt: at },
    };
    if (command === 'check.resolve') input.onResolve?.(body);
    if (command === 'file.open') input.onOpen?.(body);
    return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: true, data: data[command], meta }));
  });
}

it('shows an open weight conflict with both Handbook and Canvas values, and resolves either choice through the owner session', async () => {
  let open = true;
  const fetcher = fixture({ conflicts: () => open ? [weight] : [], onResolve: body => { if (body.choice) open = false; } });
  const store = new ShellStore(createClient(secret, fetcher));
  await store.refresh();
  const needs = needsYou({ attention: [], overflow: [], unestimated: [], conflicts: store.getSnapshot().conflicts!.items, updates: [] });
  expect(needs).toEqual([{ kind: 'weight', id: 'conflict-weight', courseId: 'c1', componentName: 'Assignments', handbook: 30, canvas: 40 }]);
  expect(conflictValue(30)).toBe('30%'); expect(conflictValue(40)).toBe('40%');
  for (const choice of ['skeleton', 'canvas'] as const) {
    open = true; await store.refresh();
    expect(await store.resolveConflict('conflict-weight', choice)).toBe(true);
    const call = fetcher.mock.calls.filter(([path]) => path === '/api/check.resolve').at(-1)! as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ conflictId: 'conflict-weight', choice });
    expect(call[1].headers).toMatchObject({ 'X-Coursework-Session': secret });
    expect(store.getSnapshot().conflicts!.items).toEqual([]);
  }
});

it('shows an unmatched Canvas item with its component picker and resolves an assignment or a dismissal', async () => {
  const fetcher = fixture({ conflicts: () => [unmatched] });
  const store = new ShellStore(createClient(secret, fetcher));
  await store.refresh();
  const needs = needsYou({ attention: [], overflow: [], unestimated: [], conflicts: store.getSnapshot().conflicts!.items, updates: [] });
  expect(needs).toEqual([{ kind: 'unmatched', id: 'conflict-unmatched', courseId: 'c1', canvasName: 'Synthetic unlisted reflection',
    components: [{ key: 'c1:assignments', name: 'Assignments' }, { key: 'c1:quizzes', name: 'Quizzes' }] }]);
  expect(await store.resolveConflict('conflict-unmatched', 'c1:assignments')).toBe(true);
  expect(JSON.parse(String((fetcher.mock.calls.filter(([path]) => path === '/api/check.resolve').at(-1)! as unknown as [string, RequestInit])[1].body)))
    .toEqual({ conflictId: 'conflict-unmatched', choice: 'c1:assignments' });
  expect(await store.resolveConflict('conflict-unmatched', 'dismissed')).toBe(true);
  expect(JSON.parse(String((fetcher.mock.calls.filter(([path]) => path === '/api/check.resolve').at(-1)! as unknown as [string, RequestInit])[1].body)))
    .toEqual({ conflictId: 'conflict-unmatched', choice: 'dismissed' });
});

it('shows a content-updated notice, opens its saved file, and clears the notice after the owner file.open call', async () => {
  let open = true;
  const fetcher = fixture({ updates: () => open ? [update] : [], onOpen: () => { open = false; } });
  const store = new ShellStore(createClient(secret, fetcher));
  await store.refresh();
  expect(needsYou({ attention: [], overflow: [], unestimated: [], conflicts: [], updates: store.getSnapshot().updates!.items }))
    .toEqual([{ kind: 'update', savedFileId: 'saved-1', courseId: 'c1', assessmentId: 'a1', assessmentName: 'Synthetic Essay', name: 'instructions.html', savedAt: at }]);
  expect(await store.openUpdate('saved-1')).toBe(true);
  const call = fetcher.mock.calls.filter(([path]) => path === '/api/file.open').at(-1)! as unknown as [string, RequestInit];
  expect(JSON.parse(String(call[1].body))).toEqual({ savedFileId: 'saved-1' });
  expect(call[1].headers).toMatchObject({ 'X-Coursework-Session': secret });
  expect(store.getSnapshot().updates!.items).toEqual([]);
});

it('refuses conflict resolution and file opening without the owner session before any server call', async () => {
  const fetcher = fixture();
  const store = new ShellStore(createClient(undefined, fetcher));
  expect(await store.resolveConflict('conflict-weight', 'skeleton')).toBe(false);
  expect(store.getSnapshot().errors.action).toBe('OWNER_SESSION_EXPIRED');
  expect(await store.openUpdate('saved-1')).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps both need kinds and turns a long kind into the first three plus a "show more" count', () => {
  const weights: Need[] = Array.from({ length: 5 }, (_, index) => ({ kind: 'weights', course: `SYN${index}`, warning: 'WEIGHT_SUM' }));
  const groups = needGroups([...weights, { kind: 'select', count: 1 }]);
  expect(groups.map(group => [group.kind, group.items.length, group.hidden])).toEqual([['weights', 5, 2], ['select', 1, 0]]);
  expect(visibleNeedItems(groups[0]!, false)).toEqual(weights.slice(0, 3));
  expect(visibleNeedItems(groups[0]!, true)).toEqual(weights);
  expect(visibleNeedItems(groups[1]!, false)).toEqual([{ kind: 'select', count: 1 }]);
  expect(needGroups([weights[0]!]).map(group => group.hidden)).toEqual([0]);
});

it('orders notices after sync needs and before planning gaps, and lists both new strings in English and Chinese', () => {
  const sync = [{ kind: 'policy' as const, course: 'SYNA10001', value: 'allowed' as const }];
  expect(needsYou({ attention: sync, conflicts: [weight], updates: [update], overflow: [], unestimated: [] }).map(item => item.kind))
    .toEqual(['policy', 'weight', 'update']);
  expect(conflictNeeds([weight, unmatched]).map(item => item.kind)).toEqual(['weight', 'unmatched']);
  expect(updateNeeds([update])).toHaveLength(1);
  expect([en.syncNeeds.useHandbook, en.syncNeeds.useCanvas, en.syncNeeds.dismiss, en.syncNeeds.contentUpdated])
    .toEqual(['Use Handbook', 'Use Canvas', 'Dismiss', 'Assessment content updated']);
  expect([zh.syncNeeds.useHandbook, zh.syncNeeds.useCanvas, zh.syncNeeds.dismiss, zh.syncNeeds.contentUpdated])
    .toEqual(['使用 Handbook', '使用 Canvas', '忽略', '考核内容已更新']);
  expect([en.coursePage.start, zh.coursePage.start]).toEqual(['Start', '开始']);
});
