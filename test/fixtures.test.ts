import { expect, it } from 'vitest';
import { synthetic } from './fixtures/synthetic.js';
import { ModuleSchema, CourseSchema, AssessmentSchema, SourceItemSchema, TaskSchema, RunSchema } from '../src/domain/schemas.js';
import { validateCourseAssessments } from '../src/domain/course.js';

it('synthetic fixtures cover every entity and satisfy domain invariants', () => {
  expect(ModuleSchema.safeParse(synthetic.module).success).toBe(true);
  expect(CourseSchema.safeParse(synthetic.course).success).toBe(true);
  expect(synthetic.course.code).toBe('COMP90099');
  synthetic.assessments.forEach(assessment => expect(AssessmentSchema.safeParse(assessment).success).toBe(true));
  expect(() => validateCourseAssessments(synthetic.course, synthetic.assessments)).not.toThrow();
  expect(SourceItemSchema.safeParse(synthetic.sourceItem).success).toBe(true);
  expect(TaskSchema.safeParse(synthetic.task).success).toBe(true);
  expect(RunSchema.safeParse(synthetic.run).success).toBe(true);
  const citation = synthetic.task.steps[0]!.citations[0]!;
  expect(citation.sourceItemId).toBe(synthetic.sourceItem.id);
  expect(synthetic.sourceItem.text).toContain(citation.quote);
  expect(synthetic.sourceItem.url).toMatch(/^https:\/\/example\.invalid\//);
});
