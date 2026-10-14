import { createHash } from 'node:crypto';
import type { Assessment, Course, Module, SourceItem, Task, Run } from '../../src/domain/schemas.js';

// Entirely invented data. No captured course pages or real student information.
export const syntheticCourse: Course = {
  id: 'course-1', moduleId: 'module-1', code: 'COMP90099',
  name: 'Fictional computing', term: '2026-S1', assessmentsComplete: true, sources: [],
};

export function syntheticAssessment(id: string, weight: number, score?: number, isFinal = false, hurdleMin?: number): Assessment {
  return { id, courseId: syntheticCourse.id, name: `Fictional ${id}`,
    kind: isFinal ? 'exam' : 'assignment', weight, score, isFinal, hurdleMin,
    origin: 'sync', status: score === undefined ? 'not_started' : 'graded' };
}

export const syntheticAssessments: Assessment[] = [
  syntheticAssessment('a', 10, 82), syntheticAssessment('b', 15, 88),
  syntheticAssessment('c', 10, 74), syntheticAssessment('d', 25),
  syntheticAssessment('final', 40, undefined, true),
];
const at = '2026-01-01T00:00:00Z';
const text = 'Read the fictional brief and outline a solution.';
const sourceItem: SourceItem = {
  id: 'source-1', platform: 'manual', externalId: 'fictional-brief-1',
  courseId: syntheticCourse.id, kind: 'assignment', title: 'Fictional assignment brief',
  url: 'https://example.invalid/brief', text,
  contentHash: createHash('sha256').update(text).digest('hex'), fetchedAt: at, removed: false,
};
const task: Task = {
  id: 'task-1', moduleId: syntheticCourse.moduleId, courseId: syntheticCourse.id,
  assessmentId: 'd', title: 'Outline the fictional assignment', source: 'coursework', done: false,
  steps: [{ title: 'Read the brief', estimateMinutes: 15, done: false,
    citations: [{ sourceItemId: sourceItem.id, quote: text, locator: 'paragraph 1' }] }],
};
const module: Module = { id: syntheticCourse.moduleId, name: 'Fictional coursework', glyph: 'book', auto: true };
const run: Run = { id: 'run-1', command: 'sync', startedAt: at, endedAt: at, steps: 1, outcome: 'ok', costUsd: 0 };

export const synthetic = { module, course: syntheticCourse, assessments: syntheticAssessments, sourceItem, task, run };
