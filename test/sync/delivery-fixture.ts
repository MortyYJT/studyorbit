import { vi } from 'vitest';
import type { RequestClock } from '../../src/capture/limiter.js';
import type { JsonResponse } from '../../src/sync/canvas-reader.js';
export const at = '2026-10-15T00:00:00Z';
export const due = '2026-10-20T00:00:00Z';
export function clock(): RequestClock { let now = Date.parse(at); return { now: () => now, sleep: async ms => { now += ms; } }; }
export const json = (body: unknown, next?: string): JsonResponse => ({ kind: 'json', status: 200, body, ...(next ? { next } : {}) });
export function canvasCourses() {
  const course = { id: 1, course_code: 'ABCD10001_2026_SM2', name: 'Synthetic Canvas', enrollments: [{ enrollment_state: 'active', type: 'student' }], term: { name: '2026 Semester 2', start_at: '2026-07-01T00:00:00Z', end_at: '2026-12-01T00:00:00Z' } };
  return [course, { ...course, id: 2, enrollments: [{ enrollment_state: 'completed', type: 'student' }] }, { ...course, id: 3, term: { ...course.term, end_at: '2026-09-01T00:00:00Z' } }];
}
export function bodies(): Record<string, unknown> {
  return {
    '/api/v1/courses?enrollment_type=student&enrollment_state=active&include[]=term&per_page=100&page=1': canvasCourses(),
    '/api/v1/courses/1/assignments?per_page=100&page=1': [7, 8].map(id => ({ id, name: `Synthetic assignment ${id}`, assignment_group_id: 3, description: 'Synthetic instructions', due_at: due, points_possible: 10 })),
    '/api/v1/courses/1/assignment_groups?per_page=100&page=1': [{ id: 3, name: 'Assignments', group_weight: 30 }, { id: 4, name: 'Unknown' }],
    '/api/v1/courses/1/modules?per_page=100&page=1': [{ id: 5, name: 'Week one' }],
    '/api/v1/courses/1/assignments/7/submissions/self': { assignment_id: 7, score: 8, submitted_at: at, workflow_state: 'graded' },
    '/api/v1/courses/1/assignments/8/submissions/self': { assignment_id: 8, score: null, submitted_at: null, workflow_state: 'unsubmitted' },
    '/api/user': [{ course: { id: 9, code: 'ABCD10001', name: 'Different name', status: 'active', year: 2026, session: 'S2' } }, { course: { id: 10, code: 'EFGH20002', name: 'Other', status: 'active', year: 2026, session: 'S1' } }],
    '/api/courses/9/lessons': { lessons: [{ id: 11, kind: 'attempt', title: 'Synthetic quiz' }, { id: 12, kind: 'content', title: 'Content' }] },
    '/api/lessons/11': { lesson: { id: 11, title: 'Synthetic quiz', due_at: due, effective_due_at: '2026-10-22T00:00:00Z', max_score: 10, score: 9, submitted: true, slides: [{ id: 21 }, { id: 22 }] } },
    '/api/lessons/slides/21': { slide: { id: 21, questions: [] } },
    '/api/lessons/slides/22': { slide: { id: 22, questions: [] } },
    '/api/courses/9/threads?limit=30&sort=new': { threads: [{ id: 41, title: 'News', content: 'Synthetic post', author: { name: 'Synthetic Peer' } }], next: 'never-follow' },
    '/api/courses/9/resources': { resources: [] },
  };
}
export function readers(input = bodies()) {
  const read = vi.fn(async (endpoint: string) => endpoint in input ? json(input[endpoint]) : { kind: 'gap' as const, status: 404, reason: 'unavailable' as const });
  return { canvas: { read }, ed: { read }, read };
}
