import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { synthetic } from '../fixtures/synthetic.js';
import { PlanningService } from '../../src/planning/service.js';
import type { Run } from '../../src/domain/schemas.js';

const roots: string[] = []; const closes: (() => void)[] = [];
afterEach(async () => { closes.splice(0).forEach(close => close()); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const from = '2026-01-01T00:00:00Z'; const to = '2026-02-01T00:00:00Z';
const at = '2026-01-10T00:00:00Z';
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'metrics-synthetic-'))); roots.push(root); vi.stubEnv('COURSEWORK_HOME', root);
  const host = createProductionProtocol(); closes.push(host.close);
  host.store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  const agent = host.registry.agentTools(host.context);
  return { ...host, read: (input: unknown = { from, to }) => dispatch(agent.registry, 'metrics.read', input, agent.context) };
}
it('reports unavailable reasons and counts rather than fabricated zero metrics; validates the half-open range', async () => {
  const { read } = await setup();
  expect(await read()).toMatchObject({ ok: true, data: {
    sync: { canvas: { available: false, reason: 'no_runs', count: 0 }, ed: { available: false, reason: 'no_runs', count: 0 } },
    accuracy: { available: false, reason: 'no_labels', count: 0 },
    estimates: { available: false, reason: 'no_items', count: 0 },
    agent: { available: false, reason: 'no_conversations', count: 0 },
  } });
  for (const input of [{ from: to, to: from }, { from, to: from }, { from: 'invalid', to }, { from, to, owner: true }]) {
    expect(await read(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }
});
it('aggregates recorded sync-run durations and provider success independently, excluding legacy and out-of-range runs', async () => {
  const { store, read } = await setup();
  function sync(id: string, start: string, duration: number, failed = false) {
    store.recordRun({ id, command: 'sync', startedAt: start, endedAt: new Date(Date.parse(start) + duration).toISOString(), steps: 2,
      outcome: failed ? 'error' : 'ok', pages: 2, requests: 2, failures: failed ? 1 : 0,
      coverage: (['canvas', 'ed'] as const).map(provider => ({ ...(provider === 'canvas' ? { provider, collection: 'assignments' as const } : { provider, collection: 'lessons' as const }), scopeRef: 'a'.repeat(64),
        planned: 1, attempted: 1, completed: failed && provider === 'ed' ? 0 : 1, failed: failed && provider === 'ed' ? 1 : 0,
        skipped: 0, notStarted: 0, codes: failed && provider === 'ed' ? ['AUTH_EXPIRED' as const] : [] })) });
  }
  sync('one', from, 1000); sync('two', at, 3000, true); sync('end-exclusive', to, 99000);
  store.recordRun({ id: 'legacy', command: 'sync', startedAt: at, endedAt: at, steps: 0, outcome: 'ok' });
  expect(await read()).toMatchObject({ ok: true, data: { sync: {
    canvas: { available: true, count: 2, medianDurationMs: 2000, maxDurationMs: 3000, successes: 2, successRate: 1, durationBasis: 'sync_run' },
    ed: { available: true, count: 2, medianDurationMs: 2000, maxDurationMs: 3000, successes: 1, successRate: 0.5 },
  } } });
});
it('computes accuracy only from in-range owner verdicts on agent annotations, including course annotations', async () => {
  const { store, read } = await setup();
  for (const [id, entity, entityId, origin] of [['agent-one', 'assessment', 'a', 'agent'], ['agent-two', 'course', synthetic.course.id, 'agent'], ['owner', 'assessment', 'a', 'owner']] as const) {
    store.appendAnnotation({ id, entity, entityId, field: 'name', value: 'Synthetic value', origin, at: from,
      citations: origin === 'agent' ? [{ sourceItemId: 'synthetic-source', quote: 'Synthetic', locator: 'page:1' }] : [] });
  }
  store.appendAnnotationVerdict({ annotationId: 'agent-one', verdict: 'correct', at });
  store.appendAnnotationVerdict({ annotationId: 'agent-two', verdict: 'incorrect', at });
  store.appendAnnotationVerdict({ annotationId: 'owner', verdict: 'correct', at });
  store.appendAnnotationVerdict({ annotationId: 'agent-one', verdict: 'correct', at: to });
  expect(await read()).toMatchObject({ ok: true, data: { accuracy: { available: true, count: 2, correct: 1, incorrect: 1, value: 0.5 } } });
});
it('uses effective owner estimates and sums in-range logs for completed work and task steps, without including future estimates', async () => {
  const { store, read } = await setup();
  store.appendEstimate({ workId: 'a', minutes: 60, origin: 'owner', at: '2025-12-31T00:00:00Z' });
  store.appendEstimate({ workId: 'a', minutes: 240, origin: 'agent', reason: 'Synthetic reason', at });
  store.appendEstimate({ workId: 'a', minutes: 999, origin: 'owner', at: to });
  store.saveTask({ id: 'task', moduleId: synthetic.module.id, title: 'Synthetic completed work', source: 'manual', done: true,
    steps: [{ title: 'Synthetic step', done: true, estimateMinutes: 0, citations: [] }] });
  store.appendEstimate({ workId: 'task', minutes: 120, origin: 'owner', at });
  for (const minutes of [50, 40]) store.appendTimeLog({ workId: 'a', minutes, at });
  store.appendTimeLog({ workId: 'task', minutes: 120, at });
  store.appendTimeLog({ workId: 'a', minutes: 600, at: to });
  store.appendTimeLog({ workId: 'b', minutes: 30, at }); // No estimate.
  expect(await read()).toMatchObject({ ok: true, data: { estimates: { available: true, count: 2, medianRatio: 1.25, meanRatio: 1.25 } } });
});
it('sums replies per conversation and groups by effective context kind, excluding unknown costs and counting them', async () => {
  const { store, read } = await setup();
  store.appendAnnotation({ id: 'kind', entity: 'assessment', entityId: 'a', field: 'kind', value: 'quiz', origin: 'owner', citations: [], at });
  for (const [id, assessmentId] of [['c1', 'a'], ['c2', 'a'], ['c3', undefined]] as const) {
    store.appendConversation({ id, title: 'Synthetic conversation', adapter: 'synthetic', assessmentId, createdAt: from, updatedAt: at });
  }
  const reply = (id: string, conversationId: string, steps: number, turns: number, costUsd?: number, startedAt = at) => {
    const run: Run = { id, command: 'agent.reply', conversationId, steps, turns, costUsd, startedAt, endedAt: startedAt, outcome: 'ok' }; store.recordRun(run);
  };
  reply('r1', 'c1', 2, 1, 0.2); reply('r2', 'c1', 3, 2, 0.3); reply('r3', 'c2', 4, 3, 0); reply('r4', 'c3', 1, 1);
  reply('outside', 'c1', 100, 100, 99, to);
  expect(await read()).toMatchObject({ ok: true, data: { agent: { available: true, count: 3,
    conversations: [
      { conversationId: 'c1', kind: 'quiz', steps: 5, turns: 3, cost: { available: true, totalUsd: 0.5, count: 1, unknownCount: 0 } },
      { conversationId: 'c2', kind: 'quiz', steps: 4, turns: 3, cost: { available: true, totalUsd: 0, count: 1, unknownCount: 0 } },
      { conversationId: 'c3', kind: 'unknown', steps: 1, turns: 1, cost: { available: false, reason: 'no_reported_costs', count: 0, unknownCount: 1 } },
    ],
    byKind: expect.arrayContaining([{ kind: 'quiz', count: 2, steps: 9, turns: 6, cost: { available: true, totalUsd: 0.5, count: 2, unknownCount: 0 } }]),
    cost: { available: true, totalUsd: 0.5, count: 2, unknownCount: 1 },
  } } });
});
it('retains the recorded assessment context after conversation deletion', async () => {
  const { store, read } = await setup();
  const conversation = { id: 'deleted', title: 'Synthetic conversation', adapter: 'synthetic', assessmentId: 'a', createdAt: from, updatedAt: at };
  store.saveChat(conversation, undefined, undefined, { id: 'retained-run', command: 'agent.reply', conversationId: conversation.id,
    startedAt: at, endedAt: at, steps: 1, turns: 2, outcome: 'ok', costUsd: 0.4 });
  store.deleteConversation(conversation.id);
  expect(await read()).toMatchObject({ ok: true, data: { agent: { available: true, count: 1,
    conversations: [{ conversationId: 'deleted', kind: 'assignment', steps: 1, turns: 2, cost: { totalUsd: 0.4 } }],
  } } });
});
it('includes explicit estimates and actuals even when a manual task is now all-day', async () => {
  const { store, read } = await setup();
  store.saveTask({ id: 'all-day', moduleId: synthetic.module.id, title: 'Synthetic all-day work', source: 'manual', allDay: true, due: at,
    steps: [{ title: 'Synthetic step', done: false, estimateMinutes: 0, citations: [] }] });
  store.appendEstimate({ workId: 'all-day', origin: 'owner', minutes: 60, at });
  store.appendTimeLog({ workId: 'all-day', minutes: 90, at });
  expect(await read()).toMatchObject({ ok: true, data: { estimates: { available: true, count: 1, medianRatio: 1.5, meanRatio: 1.5 } } });
});

it('keeps historical estimate ratios after manual.delete removes the task', async () => {
  const { store, read } = await setup();
  store.saveTask({ id: 'deleted-task', moduleId: synthetic.module.id, title: 'Synthetic work', source: 'manual',
    steps: [{ title: 'Step', done: false, estimateMinutes: 0, citations: [] }] });
  store.appendEstimate({ workId: 'deleted-task', origin: 'owner', minutes: 60, at });
  store.appendTimeLog({ workId: 'deleted-task', minutes: 90, at });
  const expected = { ok: true, data: { estimates: { available: true, count: 1, medianRatio: 1.5, meanRatio: 1.5 } } };
  expect(await read()).toMatchObject(expected);
  await new PlanningService(store).execute('manual.delete', { id: 'deleted-task' }, { assertOwner: async () => {} });
  expect(store.loadTask('deleted-task')).toBeUndefined();
  expect(store.readEstimates('deleted-task')).toHaveLength(1);
  expect(store.readTimeLogs('deleted-task')).toHaveLength(1);
  expect(await read()).toMatchObject(expected);
});

it('pages all conversation metrics within the envelope limit while retaining full-range aggregates', async () => {
  const { store, read } = await setup();
  const ids = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(3, '0')}${'界\\'.repeat(125)}`);
  for (const [i, conversationId] of ids.entries()) {
    store.appendConversation({ id: conversationId, title: 'Synthetic conversation', adapter: 'synthetic',
      assessmentId: i % 2 ? 'a' : undefined, createdAt: at, updatedAt: at });
    store.recordRun({ id: `reply-${i}`, command: 'agent.reply', conversationId,
      startedAt: at, endedAt: at, outcome: 'ok', steps: 2, turns: 1, costUsd: i % 2 ? 1 : undefined });
  }
  store.recordRun({ id: 'outside-range', command: 'agent.reply', conversationId: 'outside', startedAt: to, endedAt: to,
    outcome: 'ok', steps: 99, turns: 99, costUsd: 99 });
  const seen: string[] = []; let cursor: number | undefined; let pages = 0;
  do {
    const result = await read({ from, to, ...(cursor ? { cursor, limit: 25 } : {}) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const data = result.data as { agent: { conversations: { conversationId: string }[]; nextCursor?: number } };
    expect(data).toMatchObject({ sync: { canvas: { reason: 'no_runs' } }, accuracy: { reason: 'no_labels' }, estimates: { reason: 'no_items' },
      agent: { available: true, count: 60, cost: { totalUsd: 30, count: 30, unknownCount: 30 },
        byKind: expect.arrayContaining([{ kind: 'assignment', count: 30, steps: 60, turns: 30,
          cost: { available: true, totalUsd: 30, count: 30, unknownCount: 0 } }]) } });
    expect(data.agent.conversations.length).toBeLessThanOrEqual(25);
    seen.push(...data.agent.conversations.map(row => row.conversationId));
    cursor = data.agent.nextCursor;
    expect(++pages).toBeLessThanOrEqual(3);
  } while (cursor);
  expect(seen).toEqual(ids);
  for (const limit of [0, 26, 1.5]) expect(await read({ from, to, limit })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
