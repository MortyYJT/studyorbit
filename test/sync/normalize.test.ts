import { expect, it } from 'vitest';
import { normalizeCanvas, normalizeEdAttempt } from '../../src/sync/normalize.js';
import { at, due } from './delivery-fixture.js';
const course = { id: 'course', moduleId: 'school', code: 'ABCD10001', name: 'Synthetic', term: '2026:S2', assessmentsComplete: false, sources: [{ platform: 'canvas' as const, externalId: '1' }] };
it('5.3 creates one cited weighted group assessment, never splits or invents missing weights', () => {
  const result = normalizeCanvas(course, { assignments: [7, 8].map(id => ({ id: String(id), name: 'Synthetic', assignment_group_id: '3', due_at: due, points_possible: 10 })), groups: [{ id: '3', name: 'Assignments', group_weight: 30 }, { id: '4', name: 'Unknown' }], submissions: [{ assignment_id: '7', score: 8, submitted_at: at, workflow_state: 'graded' }], modules: [] }, at);
  expect(result.assessments).toHaveLength(1);
  expect(result.assessments[0]).toMatchObject({ origin: 'sync', weight: 30, isFinal: false });
  expect(result.links).toHaveLength(3);
  expect(result.citations[0]).toMatchObject({ quote: 'group_weight: 30', locator: expect.stringContaining('group_weight') });
  expect(result.sources.filter(s => s.kind === 'assignment').map(s => s.facts)).toContainEqual({ due, pointsPossible: 10, pointsEarned: 8, submitted: true });
  expect(result.sources.every(s => !('weight' in s))).toBe(true);
});
it('5.3 copies Ed effective due facts without assigning a weight or final classification', () => {
  const source = normalizeEdAttempt('course', '9', { id: '11', title: 'Synthetic', due_at: due, effective_due_at: at, max_score: 10, score: 9, submitted: true }, at);
  expect(source.facts).toEqual({ due: at, pointsPossible: 10, pointsEarned: 9, submitted: true });
  expect(normalizeEdAttempt('course', '9', { id: '11', title: 'Synthetic', due_at: due, effective_due_at: null }, at).facts?.due).toBeUndefined();
  expect(normalizeEdAttempt('course', '9', { id: '11', title: 'Synthetic', due_at: due }, at).facts?.due).toBe(due);
});
