import { expect, it } from 'vitest';
import { CourseAssessmentsSchema } from '../../src/domain/course.js';
import { projectGrade, GradeProjectionSchema } from '../../src/domain/grade.js';
import { syntheticCourse, syntheticAssessment } from '../fixtures/synthetic.js';

const { weight: _weight, ...unknown } = syntheticAssessment('unknown', 50);
it('names the course and unknown weights when a complete course is validated', () => {
  const result = CourseAssessmentsSchema.safeParse({ course: syntheticCourse, assessments: [unknown, syntheticAssessment('final', 50, undefined, true)] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some(issue => /COMP90099.*unknown/.test(issue.message))).toBe(true);
  expect(CourseAssessmentsSchema.safeParse({ course: { ...syntheticCourse, assessmentsComplete: false }, assessments: [unknown] }).success).toBe(true);
});
it('puts weights_unknown before every other unavailable reason and returns finite aggregates', () => {
  for (const assessments of [
    [unknown],
    [{ ...unknown, score: 80 }],
    [unknown, syntheticAssessment('final', 50, 80, true)],
    [unknown, syntheticAssessment('final', 50, undefined, true)],
  ]) {
    const result = projectGrade(syntheticCourse, assessments, 'H1');
    expect(result.need).toEqual({ status: 'unavailable', reason: 'weights_unknown' });
    expect(GradeProjectionSchema.safeParse(result).success).toBe(true);
    expect(result.gradedWeight).toBeGreaterThanOrEqual(0);
  }
});
