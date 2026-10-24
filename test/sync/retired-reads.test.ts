import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { PlanningService } from '../../src/planning/service.js';
import { projectGrade } from '../../src/domain/grade.js';
import { validateCourseAssessments } from '../../src/domain/course.js';
import type { Assessment } from '../../src/domain/schemas.js';

const stores: SqliteRepository[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const course = { id: 'c', moduleId: 'm', code: 'SYNA10001', name: 'Synthetic', term: '2026:S2', assessmentsComplete: true };
const live: Assessment = { id: 'live', courseId: 'c', name: 'Live', kind: 'assignment', weight: 100, isFinal: true, status: 'not_started', due: '2026-10-30T00:00:00Z' };
const retired: Assessment = { id: 'retired', courseId: 'c', name: 'Retired', kind: 'assignment', weight: 40, score: 10, isFinal: true, status: 'not_started', due: '2026-10-29T00:00:00Z', retired: true };

it('retired assessments are left out of assessments.list, planning, autonomy.read, the grade projection and the one-final rule', async () => {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [{ id: 'm', name: 'Synthetic', glyph: 'S', auto: true }], courses: [course], assessments: [live, retired] });
  const host = createProductionProtocol({ store, owner: { assertOwner: async () => {} } });
  const list = await dispatch(host.registry, 'assessments.list', { courseId: 'c' }, host.context);
  expect(list).toMatchObject({ ok: true });
  expect((list as { data: { items: { id: string }[] } }).data.items.map(item => item.id)).toEqual(['live']);
  const autonomy = await dispatch(host.registry, 'autonomy.read', { courseId: 'c' }, host.context);
  expect((autonomy as { data: { assessments: { assessmentId: string }[] } }).data.assessments.map(row => row.assessmentId)).toEqual(['live']);
  expect(new PlanningService(store).work('2026:S2').items.map(item => item.workId)).toEqual(['live']);
  // Retired rows still load by id for history, and import can list them.
  expect(store.loadAssessment('retired')).toMatchObject({ retired: true });
  expect(store.query('assessments', { limit: 10, includeRetired: true }).items).toHaveLength(2);
  expect(projectGrade(course, [live, retired], 'H1').gradedWeight).toBe(0);
  expect(() => validateCourseAssessments(course, [live, retired])).not.toThrow();
});
