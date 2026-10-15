import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { PlanningService } from '../../src/planning/service.js';
import { synthetic } from '../fixtures/synthetic.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { StoreStudyEvidence } from '../../src/revision/service.js';
import { SqliteStudyRecordStore } from '../../src/store/study-records.js';
import { StudyWriteService } from '../../src/protocol/study-writes.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
const stores: SqliteRepository[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments, tasks: [synthetic.task], sourceItems: [synthetic.sourceItem] });
  return { store, service: new PlanningService(store) };
}
it('submitted and removed linked work drops out, including its steps; exams are deadlines only', () => {
  const { store, service } = setup();
  const link = { assessmentId: 'd', sourceItemId: synthetic.sourceItem.id, origin: 'sync' as const, at: '2026-01-01T00:00:00Z' };
  store.appendAssessmentLink(link);
  expect(service.work('2026-S1').items.map(x => x.workId)).toEqual(['d', 'task-1:step:0']);
  expect(service.work('2026-S1').deadlines.map(x => x.workId)).toEqual(['final']);
  store.saveSourceItem({ ...synthetic.sourceItem, facts: { submitted: true } });
  expect(service.work('2026-S1').items).toEqual([]);
  store.saveSourceItem({ ...synthetic.sourceItem, removed: true });
  expect(service.work('2026-S1').items).toEqual([]);
  expect(service.work('other-term').deadlines).toEqual([]);
});
it('plans the accepted SQLite breakdown and validates its step targets instead of a stale task copy', async () => {
  const { store, service } = setup();
  store.saveSourceItem({ ...synthetic.sourceItem, url: undefined });
  const evidence = new TrustedStoreEvidence(store);
  const provider = new StoreStudyEvidence(store, evidence);
  const writer = new StudyWriteService({ provider, store: new SqliteStudyRecordStore(store, evidence) });
  const sourceRevision = (await provider.resolve({ courseId: synthetic.course.id, assessmentId: 'd' })).sourceRevision;
  const step = { ...synthetic.task.steps[0]!, title: 'Accepted step', citations: [{ ...synthetic.task.steps[0]!.citations[0]!, locator: synthetic.sourceItem.id }] };
  await writer.write('breakdown.write', { assessmentId: 'd', sourceRevision, task: { ...synthetic.task,
    steps: [{ ...step, done: true }, step] } }, createFakeContext());
  const workId = 'task-1:step:1';
  expect(service.work('2026-S1').items.filter(item => item.workId.startsWith('task-1:'))).toEqual([
    expect.objectContaining({ workId, title: 'Accepted step' }),
  ]);
  await expect(service.execute('estimate.agent.set', { workId, minutes: 20, reason: 'Read the accepted brief' })).resolves.toEqual({ recorded: true });
  await service.saveSettings({ weekdayMinutes: [60, 60, 60, 60, 60, 0, 0], teachingWeekAnchor: '2026-10-19', breakWeeks: [] }, { assertOwner: async () => {} });
  expect(service.plan({ term: '2026-S1', startDate: '2026-10-19', horizonDays: 1 }).days[0]!.items).toEqual([
    expect.objectContaining({ workId, minutes: 20 }),
  ]);
});
it('leaves coursework step durations unestimated until a reasoned estimate is recorded', async () => {
  const { service } = setup();
  const workId = 'task-1:step:0';
  const before = service.work('2026-S1').items.find(item => item.workId === workId)!;
  expect(before.estimateMinutes).toBeUndefined();
  expect(before.estimateOrigin).toBeUndefined();
  await expect(service.execute('estimate.agent.set', { workId, minutes: 15 })).rejects.toThrow();
  await service.execute('estimate.agent.set', { workId, minutes: 15, reason: 'Read the cited brief' });
  expect(service.work('2026-S1').items.find(item => item.workId === workId)).toMatchObject({
    estimateMinutes: 15, estimateOrigin: 'agent', agentEstimate: { minutes: 15, reason: 'Read the cited brief' },
  });
});
it('includes unfinished manual tasks and unfinished steps but keeps all-day tasks in their date row', () => {
  const { store, service } = setup();
  store.saveTask({ ...synthetic.task, id: 'manual', source: 'manual', courseId: undefined, assessmentId: undefined,
    title: 'Internship application', due: '2026-10-23T00:00:00Z', steps: [{ title: 'Apply', estimateMinutes: 120, done: false, citations: [] }] });
  store.saveTask({ ...store.loadTask('manual')!, id: 'fair', title: 'Career fair', allDay: true, due: '2026-10-22T00:00:00Z' });
  store.saveTask({ ...synthetic.task, id: 'finished', done: true });
  const work = service.work('2026-S1');
  expect(work.items.map(x => x.workId)).toEqual(['d', 'manual', 'task-1:step:0']);
  expect(work.items.find(x => x.workId === 'manual')).toMatchObject({ estimateMinutes: 120, estimateOrigin: 'owner' });
  expect(work.deadlines.find(x => x.workId === 'fair')).toMatchObject({ date: '2026-10-22', title: 'Career fair' });
  store.saveTask({ ...store.loadTask('manual')!, done: true });
  expect(service.work('2026-S1').items.some(x => x.workId === 'manual')).toBe(false);
});
