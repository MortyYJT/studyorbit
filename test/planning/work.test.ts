import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { PlanningService } from '../../src/planning/service.js';
import { synthetic } from '../fixtures/synthetic.js';
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
