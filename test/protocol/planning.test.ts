import { afterEach, expect, it } from 'vitest';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { httpCommandContext } from '../../src/protocol/http.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { PlanningService } from '../../src/planning/service.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { synthetic } from '../fixtures/synthetic.js';
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
    days: [{ items: [{ workId: 'd', minutes: 60, estimateMinutes: 180, estimateOrigin: 'owner', actualMinutes: 50, startTime: '09:00', agentEstimate: { minutes: 240, reason: 'Read and draft' } }] }, { items: [{ workId: 'd', minutes: 60 }] }],
    overflow: [{ workId: 'd', minutes: 60 }], unestimated: [{ title: 'Unestimated' }],
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
