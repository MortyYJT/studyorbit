import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { ConversationService } from '../../src/agent/conversations.js';
import { renderPreset } from '../../src/agent/presets.js';
import { SyntheticAdapter } from './synthetic.js';
import { hash } from '../../src/citations/exact.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const at = '2026-10-24T00:00:00Z';
const quizUrl = 'https://canvas.lms.unimelb.edu.au/courses/900001/quizzes/700001';

function setup() {
  const store = new SqliteRepository(':memory:');
  cleanups.push(() => store.close());
  store.saveModule({ id: 'm-1', name: 'Synthetic', glyph: 'S', auto: false });
  store.saveCourse({ id: 'c-1', moduleId: 'm-1', code: 'SYNA10001', name: 'Synthetic course', term: '2026:S2', assessmentsComplete: false });
  store.saveAssessment({ id: 'quiz-1', courseId: 'c-1', name: 'Synthetic quiz', kind: 'quiz', isFinal: false, status: 'not_started' });
  store.saveAssessment({ id: 'assignment-1', courseId: 'c-1', name: 'Synthetic assignment', kind: 'assignment', isFinal: false, status: 'not_started' });
  store.saveAssessment({ id: 'exam-1', courseId: 'c-1', name: 'Synthetic exam', kind: 'exam', isFinal: true, status: 'not_started' });
  store.saveSourceItem({ id: 'quiz-source', platform: 'canvas', externalId: 'canvas:quiz:700001', courseId: 'c-1', kind: 'assignment',
    title: 'Synthetic quiz', url: quizUrl, text: '', contentHash: hash(''), fetchedAt: at });
  store.appendAssessmentLink({ assessmentId: 'quiz-1', sourceItemId: 'quiz-source', origin: 'sync', at });
  // The owner granted quizzes L1 on this course.
  store.appendCourseAutonomy({ courseId: 'c-1', defaultLevel: 1, at });
  return { store, chat: new ConversationService(store, new SyntheticAdapter()) };
}

it('Start a quiz: names its URL and granted level; an assignment points at assessment.files; an exam has no start preset', async () => {
  const f = setup();
  const quiz = renderPreset(f.store, { preset: 'start-assessment', courseId: 'c-1', assessmentId: 'quiz-1' })!;
  expect(quiz).toContain(quizUrl);
  expect(quiz).toMatch(/L1|level 1/i);
  expect(quiz).toMatch(/never press a final submit/i);

  const assignment = renderPreset(f.store, { preset: 'start-assessment', courseId: 'c-1', assessmentId: 'assignment-1' })!;
  expect(assignment).toContain('assessment.files');
  expect(assignment).toContain('assignment-1');
  expect(assignment).toMatch(/annotations?/i);

  expect(() => renderPreset(f.store, { preset: 'start-assessment', courseId: 'c-1', assessmentId: 'exam-1' })).toThrow();
  expect(f.chat.availablePresets({ courseId: 'c-1', assessmentId: 'exam-1' })).toEqual([]);
  expect(f.chat.availablePresets({ courseId: 'c-1', assessmentId: 'quiz-1' }).map(preset => preset.id)).toContain('start-assessment');
});

it('the start preset follows the effective kind: an owner-annotated quiz gets the quiz prompt and an annotated exam has none', () => {
  const f = setup();
  f.store.appendAnnotation({ id: 'owner-quiz', entity: 'assessment', entityId: 'assignment-1', field: 'kind', value: 'quiz', origin: 'owner', citations: [], at });
  f.store.appendAssessmentLink({ assessmentId: 'assignment-1', sourceItemId: 'quiz-source', origin: 'sync', at });
  const quiz = renderPreset(f.store, { preset: 'start-assessment', courseId: 'c-1', assessmentId: 'assignment-1' })!;
  expect(quiz).toContain(quizUrl);
  expect(quiz).not.toContain('assessment.files');

  f.store.appendAnnotation({ id: 'owner-exam', entity: 'assessment', entityId: 'quiz-1', field: 'kind', value: 'exam', origin: 'owner', citations: [], at });
  expect(() => renderPreset(f.store, { preset: 'start-assessment', courseId: 'c-1', assessmentId: 'quiz-1' })).toThrow();
  expect(f.chat.availablePresets({ courseId: 'c-1', assessmentId: 'quiz-1' })).toEqual([]);
});
