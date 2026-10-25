import { afterEach, expect, it } from 'vitest';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { httpCommandContext } from '../../src/protocol/http.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { PlanningService } from '../../src/planning/service.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { synthetic } from '../fixtures/synthetic.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { StoreStudyEvidence } from '../../src/revision/service.js';
import { SqliteStudyRecordStore } from '../../src/store/study-records.js';
import { StudyWriteService } from '../../src/protocol/study-writes.js';
const stores: SqliteRepository[] = []; afterEach(() => stores.splice(0).forEach(store => store.close()));
const scope = { term: '2026-S1', startDate: '2026-10-19', horizonDays: 2 };
const settings = { weekdayMinutes: [60, 60, 60, 60, 60, 0, 0], teachingWeekAnchor: scope.startDate, breakWeeks: [] };
function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: [{ ...synthetic.assessments[3]!, due: '2026-10-20T00:00:00Z' }] });
  const service = new PlanningService(store); const registry = createRegistry({ planning: service }); const context = createFakeContext({ owner: true });
  return { registry, context, service, store, call: (name: string, input: unknown) => dispatch(registry, name, input, context) };
}
it('plan.read exposes effective estimates, agent reasons, starts, actuals, overflow and unestimated through dispatch', async () => {
  const { call } = setup();
  expect(await call('planning.settings.set', settings)).toMatchObject({ ok: true });
  expect(await call('estimate.agent.set', { workId: 'd', minutes: 240, reason: 'Read and draft' })).toMatchObject({ ok: true });
  expect(await call('estimate.owner.set', { workId: 'd', minutes: 180 })).toMatchObject({ ok: true });
  expect(await call('time.record', { workId: 'd', minutes: 50 })).toMatchObject({ ok: true });
  expect(await call('plan.start.set', { ...scope, workId: 'd', date: scope.startDate, time: '09:00' })).toMatchObject({ ok: true });
  expect(await call('manual.create', { moduleId: synthetic.module.id, title: 'Unestimated' })).toMatchObject({ ok: true });
  expect(await call('plan.read', scope)).toMatchObject({ ok: true, data: {
    days: [{ items: [{ workId: 'd', minutes: 60, startTime: '09:00' }] }, { items: [{ workId: 'd', minutes: 60 }] }],
    work: expect.arrayContaining([expect.objectContaining({ workId: 'd', estimateMinutes: 180, estimateOrigin: 'owner', actualMinutes: 50, agentEstimate: { minutes: 240, reason: 'Read and draft' } }), expect.objectContaining({ title: 'Unestimated' })]),
    overflow: [{ workId: 'd', minutes: 60 }], unestimated: [{ workId: expect.any(String) }],
  } });
});
it('agent discovery includes only plan reads and agent estimates; settings refuse agents without mutation', async () => {
  const { registry, context, store } = setup(); const agent = registry.agentTools(context);
  expect(agent.registry.get('plan.read')).toBeDefined(); expect(agent.registry.get('estimate.agent.set')).toBeDefined();
  expect(agent.registry.get('planning.settings.set')).toBeUndefined(); expect(agent.registry.get('manual.create')).toBeUndefined();
  expect(await dispatch(registry, 'planning.settings.set', settings, agent.context)).toMatchObject({ ok: false });
  expect(store.readPlanningSettings()).toEqual([]);
});
it('settings accept an owner session or TTY, while start times and time logs require the frontend session', async () => {
  const { registry, context, call } = setup();
  expect(await dispatch(registry, 'planning.settings.set', settings, httpCommandContext(context, 'planning.settings.set', true, () => false))).toMatchObject({ ok: true });
  const out: string[] = [];
  await parseProtocolCLI(['planning', 'settings', 'set', '--weekday-minutes', JSON.stringify(settings.weekdayMinutes), '--teaching-week-anchor', settings.teachingWeekAnchor, '--break-weeks', '[]'], { registry, context, isTTY: true, stdout: s => out.push(s), stderr: () => {} });
  expect(JSON.parse(out[0]!)).toMatchObject({ ok: true });
  await call('estimate.owner.set', { workId: 'd', minutes: 20 });
  for (const [name, input] of [['plan.start.set', { ...scope, workId: 'd', date: scope.startDate, time: '09:00' }], ['time.record', { workId: 'd', minutes: 20 }]] as const) {
    const responses: string[] = [];
    await parseProtocolCLI(name.split('.').concat(Object.entries(input).flatMap(([key, value]) => ['--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), String(value)])), { registry, context, isTTY: true, stdout: s => responses.push(s), stderr: () => {} });
    expect(JSON.parse(responses[0]!)).toMatchObject({ ok: false });
    expect(await dispatch(registry, name, input, httpCommandContext(context, name, true, () => false))).toMatchObject({ ok: true });
  }
});
it('all planning owner commands refuse unauthenticated calls, and writes audit before mutation', async () => {
  const { registry, context, store, call } = setup();
  const entries = registry.list().filter(entry => entry.authority?.startsWith('owner') && /^(planning|estimate|plan|time|manual)\./.test(entry.name));
  expect(entries.length).toBe(9);
  expect(await call('planning.settings.set', settings)).toMatchObject({ ok: true });
  expect(context.events).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'planning.settings.set', phase: 'intent' }), expect.objectContaining({ command: 'planning.settings.set', phase: 'outcome' })]));
  context.audit.record = async () => { throw Error('journal unavailable'); };
  expect(await call('estimate.owner.set', { workId: 'd', minutes: 40 })).toMatchObject({ ok: false });
  expect(store.readEstimates('d')).toEqual([]);
});
it('manual tasks are frontend owner actions and refuse TTY creation', async () => {
  const { registry, context, store } = setup(); const responses: string[] = [];
  await parseProtocolCLI(['manual', 'create', '--module-id', synthetic.module.id, '--title', 'Career fair'], { registry, context, isTTY: true, stdout: s => responses.push(s), stderr: () => {} });
  expect(JSON.parse(responses[0]!)).toMatchObject({ ok: false });
  expect(store.query('tasks', { limit: 10 }).items).toEqual([]);
});
it('pages all legal long-title work within the envelope bound without changing global allocations', async () => {
  const { call, service, store, context } = setup();
  await call('planning.settings.set', settings);
  store.saveSourceItem({ ...synthetic.sourceItem, url: undefined });
  const evidence = new TrustedStoreEvidence(store);
  const provider = new StoreStudyEvidence(store, evidence);
  const writer = new StudyWriteService({ provider, store: new SqliteStudyRecordStore(store, evidence) });
  const sourceRevision = (await provider.resolve({ courseId: synthetic.course.id, assessmentId: 'd' })).sourceRevision;
  await writer.write('breakdown.write', { assessmentId: 'd', sourceRevision, task: { ...synthetic.task, steps: [{
    ...synthetic.task.steps[0]!, title: '大'.repeat(20000), citations: [{ ...synthetic.task.steps[0]!.citations[0]!, locator: synthetic.sourceItem.id }],
  }] } }, context);
  expect(await call('estimate.agent.set', { workId: 'task-1:step:0', minutes: 120, reason: '理'.repeat(2048) })).toMatchObject({ ok: true });
  const ids: string[] = [];
  for (let i = 0; i < 80; i++) {
    const result = await call('manual.create', { moduleId: synthetic.module.id, title: '任'.repeat(1024), ...(i < 40 ? {} : { estimateMinutes: 120 }) });
    expect(result.ok).toBe(true);
    ids.push((result as { data: { id: string } }).data.id);
  }
  const input = { ...scope, horizonDays: 1 };
  const expected = service.plan(input);
  const works: unknown[] = [], unestimated: unknown[] = [], overflow: unknown[] = [], days: unknown[] = [];
  const continuations: { workId: string; field: 'title' | 'agentEstimate.reason'; offset: number; text: string }[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await call('plan.read', { ...input, ...(cursor ? { cursor } : {}) });
    expect(response.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(64 * 1024);
    const data = (response as { data: { work: unknown[]; unestimated: unknown[]; overflow: unknown[]; days: unknown[]; nextCursor?: string; textContinuations?: typeof continuations } }).data;
    works.push(...data.work); unestimated.push(...data.unestimated); overflow.push(...data.overflow); days.push(...data.days);
    continuations.push(...data.textContinuations ?? []);
    cursor = data.nextCursor;
    if (cursor) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); }
  } while (cursor);
  for (const part of continuations) {
    const work = (works as { workId: string; title: string; agentEstimate?: { reason: string } }[]).find(item => item.workId === part.workId)!;
    const prefix = part.field === 'title' ? work.title : work.agentEstimate!.reason;
    expect(prefix.length).toBe(part.offset);
    if (part.field === 'title') work.title += part.text;
    else work.agentEstimate!.reason += part.text;
  }
  expect(continuations.length).toBeGreaterThan(0);
  expect(seen.size).toBeGreaterThan(0);
  expect(works).toEqual(expected.work);
  expect(new Set((works as { workId: string }[]).map(item => item.workId))).toEqual(new Set(['d', 'task-1:step:0', ...ids]));
  expect(unestimated).toEqual(expected.unestimated.map(({ workId }) => ({ workId })));
  expect(overflow).toEqual(expected.overflow.map(({ workId, minutes }) => ({ workId, minutes })));
  expect(days).toEqual(expected.days.map(day => ({ ...day, items: day.items.map(({ workId, minutes, startTime }) => ({ workId, minutes, ...(startTime ? { startTime } : {}) })) })));
  expect(await call('plan.read', { ...input, startDate: '2026-10-20', cursor: [...seen][0] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
it('preserves personal text across continuations', async () => {
  const { call, store } = setup();
  await call('planning.settings.set', settings);
  store.saveBatch({ tasks: [{ ...synthetic.task, assessmentId: 'd', steps: [{ ...synthetic.task.steps[0]!, done: false, title: `${'x'.repeat(16377)} alice@example.invalid` }] }] });
  let text = ''; let cursor: string | undefined;
  do {
    const response = await call('plan.read', { ...scope, ...(cursor ? { cursor } : {}) });
    expect(response.ok).toBe(true);
    const data = (response as { data: { work: { workId: string; title: string }[]; nextCursor?: string; textContinuations?: { workId: string; text: string }[] } }).data;
    text += data.work.filter(item => item.workId === `${synthetic.task.id}:step:0`).map(item => item.title).join('');
    text += (data.textContinuations ?? []).filter(part => part.workId === `${synthetic.task.id}:step:0`).map(part => part.text).join('');
    cursor = data.nextCursor;
  } while (cursor);
  expect(text.length).toBeGreaterThan(16000);
  expect(text).toBe(`${'x'.repeat(16377)} alice@example.invalid`);
});
