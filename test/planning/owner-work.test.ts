import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { PlanningService } from '../../src/planning/service.js';
import { synthetic } from '../fixtures/synthetic.js';
const stores: SqliteRepository[] = []; afterEach(() => stores.splice(0).forEach(store => store.close()));
const owner = { assertOwner: async () => {} };
const scope = { term: '2026-S1', startDate: '2026-10-19', horizonDays: 2 };
async function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: [{ ...synthetic.assessments[3]!, due: '2026-10-20T01:00:00Z' }] });
  const service = new PlanningService(store);
  await service.saveSettings({ weekdayMinutes: [60, 60, 60, 60, 60, 60, 60], teachingWeekAnchor: scope.startDate, breakWeeks: [] }, owner);
  return { store, service, command: (name: string, input: unknown, ...authority: (typeof owner | undefined)[]) => service.execute(name, input, authority.length ? authority[0] : owner) };
}
it('agent estimates require a reason and cannot spoof origin; owner wins over later agent estimates', async () => {
  const { command, service, store } = await setup();
  for (const input of [{ workId: 'd', minutes: 240 }, { workId: 'd', minutes: 240, reason: ' ' }, { workId: 'd', minutes: 240, reason: 'Read and draft', origin: 'owner' }])
    await expect(command('estimate.agent.set', input, undefined)).rejects.toThrow();
  expect(store.readEstimates('d')).toEqual([]);
  await command('estimate.agent.set', { workId: 'd', minutes: 240, reason: 'Read and draft' }, undefined);
  await command('estimate.owner.set', { workId: 'd', minutes: 180 });
  await command('estimate.agent.set', { workId: 'd', minutes: 300, reason: 'More research' }, undefined);
  expect(service.work(scope.term).items[0]).toMatchObject({ estimateMinutes: 180, estimateOrigin: 'owner', agentEstimate: { minutes: 300, reason: 'More research' } });
});
it('start times reorder timed before untimed without changing allocations and are durably dropped after movement', async () => {
  const { command, service, store } = await setup();
  await command('estimate.owner.set', { workId: 'd', minutes: 20 });
  const b = await command('manual.create', { moduleId: synthetic.module.id, title: 'B', estimateMinutes: 20 }) as { id: string };
  const c = await command('manual.create', { moduleId: synthetic.module.id, title: 'C', estimateMinutes: 20 }) as { id: string };
  await command('plan.start.set', { ...scope, workId: b.id, date: scope.startDate, time: '14:00' });
  await command('plan.start.set', { ...scope, workId: c.id, date: scope.startDate, time: '09:30' });
  expect(service.plan(scope).days[0]!.items.map(x => x.workId)).toEqual([c.id, b.id, 'd']);
  await command('plan.start.clear', { workId: c.id, date: scope.startDate });
  expect(service.plan(scope).days[0]!.items[0]).toMatchObject({ workId: b.id, startTime: '14:00' });
  await service.saveSettings({ ...service.settings()!, weekdayMinutes: [0, 60, 60, 60, 60, 60, 60] }, owner);
  expect(service.plan(scope).days[1]!.items.every(x => x.startTime === undefined)).toBe(true);
  expect(store.readStartTimes(b.id)).toEqual([]);
  await service.saveSettings({ ...service.settings()!, weekdayMinutes: [60, 60, 60, 60, 60, 60, 60] }, owner);
  expect(service.plan(scope).days[0]!.items.every(x => x.startTime === undefined)).toBe(true);
});
it('actual time sums multiple owner sessions independently of estimates', async () => {
  const { command, service } = await setup();
  await command('time.record', { workId: 'd', minutes: 50 }); await command('time.record', { workId: 'd', minutes: 40 });
  expect(service.work(scope.term).items[0]).toMatchObject({ actualMinutes: 90 });
  expect(service.work(scope.term).items[0]?.estimateMinutes).toBeUndefined();
});
it('manual create edit complete delete require owner and all-day tasks consume no minutes', async () => {
  const { command, service, store } = await setup();
  const created = await command('manual.create', { moduleId: synthetic.module.id, title: 'Internship application', due: '2026-10-20T01:00:00Z', estimateMinutes: 120 }) as { id: string };
  expect(service.plan(scope).days.flatMap(day => day.items).filter(x => x.workId === created.id).reduce((n, x) => n + x.minutes, 0)).toBe(120);
  for (const [name, input] of [['manual.create', { moduleId: synthetic.module.id, title: 'Agent task' }], ['manual.edit', { id: created.id, title: 'Changed' }], ['manual.complete', { id: created.id }], ['manual.delete', { id: created.id }]] as const)
    await expect(command(name, input, undefined)).rejects.toThrow();
  expect(store.loadTask(created.id)?.title).toBe('Internship application');
  await command('manual.edit', { id: created.id, title: 'Career fair', allDay: true });
  const plan = service.plan(scope);
  expect(plan.deadlines.find(x => x.workId === created.id)).toMatchObject({ date: '2026-10-20', title: 'Career fair' });
  expect(plan.days.flatMap(day => day.items).some(x => x.workId === created.id)).toBe(false);
  await command('manual.complete', { id: created.id });
  expect(service.plan(scope).deadlines.some(x => x.workId === created.id)).toBe(false);
  await command('manual.delete', { id: created.id }); expect(store.loadTask(created.id)).toBeUndefined();
});
it('drops stored start times when linked assessment work disappears and does not resurrect them', async () => {
  const { command, service, store } = await setup();
  await command('estimate.owner.set', { workId: 'd', minutes: 20 });
  await command('plan.start.set', { ...scope, workId: 'd', date: scope.startDate, time: '09:00' });
  store.saveAssessment({ ...store.loadAssessment('d')!, status: 'submitted' });
  expect(service.plan(scope).days[0]!.items).toEqual([]);
  expect(store.readStartTimes('d')).toEqual([]);
  store.saveAssessment({ ...store.loadAssessment('d')!, status: 'not_started' });
  expect(service.plan(scope).days[0]!.items[0]?.startTime).toBeUndefined();
});
