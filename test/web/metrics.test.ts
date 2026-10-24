import { expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { defaultRange, formatDuration, loadMetrics, metricsCards, rangeInput } from '../../web/src/metrics.js';
import { en, zh } from '../../web/src/i18n.js';
const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const range = { from: '2026-09-23T14:00:00.000Z', to: '2026-10-23T13:00:00.000Z' };
const none = <R extends string>(reason: R) => ({ available: false as const, reason, count: 0 as const });
const totals = (steps: number, turns: number, totalUsd?: number) => ({ steps, turns,
  cost: totalUsd === undefined ? { ...none('no_reported_costs'), unknownCount: 1 } : { available: true as const, totalUsd, count: 1, unknownCount: 0 } });
const empty = { ...range, sync: { runs: none('no_runs'), canvas: none('no_runs'), ed: none('no_runs') }, accuracy: none('no_labels'), estimates: none('no_items'), agent: none('no_conversations') };
it('defaults to the last 30 days in the owner time zone, end date inclusive, across a DST change', () => {
  const dates = defaultRange(new Date('2026-10-23T05:00:00Z'), 'Australia/Melbourne');
  expect(dates).toEqual({ from: '2026-09-24', to: '2026-10-23' });
  expect(rangeInput(dates, 'Australia/Melbourne')).toEqual(range);
  expect(rangeInput({ from: '2026-10-24', to: '2026-10-23' }, 'Australia/Melbourne')).toBeUndefined();
});
it('shows every metric without data as unavailable with its reason, never as zero', () => {
  const cards = metricsCards(empty, en, 'en');
  expect(cards.map(card => [card.key, card.value, card.reason])).toEqual([
    ['canvas', undefined, en.mNoRuns], ['ed', undefined, en.mNoRuns], ['accuracy', undefined, en.mNoLabels],
    ['estimates', undefined, en.mNoItems], ['agent', undefined, en.mNoConversations]]);
  expect(cards.flatMap(card => card.facts)).toEqual([]);
  expect(metricsCards(empty, zh, 'zh')[2]!.reason).toBe(zh.mNoLabels);
});
it('formats values with their counts and reports unknown costs separately', () => {
  const data = { ...empty,
    sync: { runs: none('no_runs'), canvas: { available: true as const, count: 4, successes: 3, successRate: 0.75, medianDurationMs: 2500, maxDurationMs: 221000, durationBasis: 'sync_run' as const }, ed: none('no_runs') },
    accuracy: { available: true as const, count: 10, correct: 9, incorrect: 1, value: 0.9 },
    estimates: { available: true as const, count: 2, medianRatio: 1.25, meanRatio: 1.25 },
    agent: { available: true as const, count: 3, cost: { available: true as const, totalUsd: 0.06, count: 2, unknownCount: 1 }, conversations: [], byKind: [] } };
  const [canvas, , accuracy, estimates, agent] = metricsCards(data, en, 'en');
  expect(canvas!.value).toBe('2.5s · 75%');
  expect(canvas!.facts).toContainEqual([en.mSuccess, '3 / 4']);
  expect(canvas!.facts).toContainEqual([en.mMax, '3m 41s']);
  expect(accuracy!.value).toBe('90%');
  expect(accuracy!.facts).toContainEqual([en.mVerdicts, '10']);
  expect(estimates!.value).toBe('1.25×');
  expect(estimates!.facts).toContainEqual([en.mItems, '2']);
  expect(agent!.facts).toContainEqual([en.mCost, '$0.06 (2)']);
  expect(agent!.facts).toContainEqual([en.mCostUnknown, '1']);
  expect(formatDuration(850, zh)).toBe('850毫秒');
});
it('pages conversation details and keeps the first page aggregates', async () => {
  const row = (id: string) => ({ conversationId: id, kind: 'quiz' as const, ...totals(2, 1) });
  const agent = (rows: ReturnType<typeof row>[], nextCursor?: number) => ({ available: true, count: 26, cost: { ...none('no_reported_costs'), unknownCount: 26 },
    conversations: rows, ...(nextCursor === undefined ? {} : { nextCursor }), byKind: [{ kind: 'quiz', count: 26, ...totals(52, 26) }] });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const cursor = JSON.parse(String(init!.body)).cursor;
    const data = { ...empty, agent: cursor ? agent([row('c26')]) : agent([row('c01')], 25) };
    return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command: 'metrics.read', ok: true, data, meta }));
  });
  const client = createClient(undefined, fetcher);
  const first = await loadMetrics(client, range);
  const more = await loadMetrics(client, range, first);
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ ...range, cursor: 25 });
  expect(more.agent.available && more.agent.conversations.map(item => item.conversationId)).toEqual(['c01', 'c26']);
  expect(more.agent.available && more.agent.nextCursor).toBeUndefined();
});
