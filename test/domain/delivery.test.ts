import { expect, it } from 'vitest';
import * as schemas from '../../src/domain/schemas.js';
import { delivery, at } from '../fixtures/delivery.js';
import { synthetic } from '../fixtures/synthetic.js';

it.each(Object.entries(delivery))('preserves every %s field', (name, value) => {
  const schema = (schemas as unknown as Record<string, { parse(value: unknown): unknown }>)[`${name}Schema`];
  expect(schema, `${name} schema`).toBeDefined();
  expect(schema.parse(value)).toEqual(value);
});
it('preserves new course, assessment, source, task and reply-run fields', () => {
  const course = { ...synthetic.course, sources: [{ platform: 'canvas', externalId: 'external-1' }, { platform: 'ed', externalId: 'external-2' }] };
  expect(schemas.CourseSchema.parse(course)).toEqual(course);
  const assessment = { ...synthetic.assessments[0], kind: 'quiz', origin: 'owner' };
  expect(schemas.AssessmentSchema.parse(assessment)).toEqual(assessment);
  const { kind: _kind, weight: _weight, ...unknown } = assessment;
  expect(schemas.AssessmentSchema.parse(unknown)).toEqual(unknown);
  const source = { ...synthetic.sourceItem, removed: true, facts: { due: at, pointsPossible: 10, pointsEarned: 8, submitted: true } };
  expect(schemas.SourceItemSchema.parse(source)).toEqual(source);
  const task = { ...synthetic.task, source: 'manual', due: at, done: true, allDay: true, steps: [{ title: 'Attend', estimateMinutes: 0, done: true, citations: [] }] };
  expect(schemas.TaskSchema.parse(task)).toEqual(task);
  const run = { ...synthetic.run, command: 'agent.reply', conversationId: 'conversation-1', turns: 2 };
  expect(schemas.RunSchema.parse(run)).toEqual(run);
});
it.each([
  ['Estimate', { ...delivery.Estimate, reason: undefined }, 'reason'],
  ['CourseAutonomy', { ...delivery.CourseAutonomy, defaultLevel: 3 }, 'defaultLevel'],
  ['Annotation', { ...delivery.Annotation, citations: [] }, 'citations'],
])('rejects invalid %s at %s', (name, value, path) => {
  const schema = (schemas as unknown as Record<string, { safeParse(value: unknown): { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }>)[`${name}Schema`];
  expect(schema).toBeDefined();
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map(issue => issue.path)).toContainEqual([path]);
});
it('restricts facts to assignments and all-day tasks to dated manual work', () => {
  expect(schemas.SourceItemSchema.safeParse({ ...synthetic.sourceItem, kind: 'material', facts: { submitted: true } }).success).toBe(false);
  expect(schemas.TaskSchema.safeParse({ ...synthetic.task, allDay: true, due: at }).success).toBe(false);
  expect(schemas.TaskSchema.safeParse({ ...synthetic.task, source: 'manual', steps: [{ title: 'Attend', estimateMinutes: 0, done: false, citations: [] }], allDay: true }).success).toBe(false);
});
it('ties practice attempts to stored revision ids and refuses answer text', () => {
  const attempt = { ...delivery.PracticeAttempt, revision: '00000000-0000-4000-8000-000000000001' };
  expect(schemas.PracticeAttemptSchema.parse(attempt)).toEqual(attempt);
  expect(schemas.PracticeAttemptSchema.safeParse({ ...attempt, answer: 'Fictional answer' }).success).toBe(false);
});
it('requires conversation identity and reported turns for agent replies', () => {
  expect(schemas.RunSchema.safeParse({ ...synthetic.run, command: 'agent.reply' }).success).toBe(false);
});
