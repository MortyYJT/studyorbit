import { z } from 'zod';
import { AssessmentSchema, CourseSchema, type Assessment, type Course } from './schemas.js';

/** Validate the complete assessment list together with its owning course. */
export const CourseAssessmentsSchema = z.object({
  course: CourseSchema,
  assessments: z.array(AssessmentSchema),
}).superRefine(({ course, assessments: listed }, ctx) => {
  const assessments = listed.filter(assessment => assessment.retired !== true);
  const sum = assessments.reduce((total, assessment) => total + (assessment.weight ?? 0), 0);
  // Allow only accumulated floating point error, not a missing assessment weight.
  const tolerance = Number.EPSILON * 100 * Math.max(1, assessments.length);
  if (course.assessmentsComplete && assessments.some(assessment => assessment.weight === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['assessments'], message: `Course ${course.code} (${course.id}) has unknown assessment weights` });
  } else if (course.assessmentsComplete && Math.abs(sum - 100) > tolerance) {
    ctx.addIssue({ code: 'custom', path: ['assessments'], message: `Course ${course.code} (${course.id}) assessment weights sum to ${sum}; expected 100` });
  }
  if (assessments.filter(assessment => assessment.isFinal).length > 1) {
    ctx.addIssue({ code: 'custom', path: ['assessments'], message: `Course ${course.code} has more than one final assessment` });
  }
  listed.forEach((assessment, index) => {
    if (assessment.courseId !== course.id) {
      ctx.addIssue({ code: 'custom', path: ['assessments', index, 'courseId'], message: `Assessment must belong to course ${course.code} (${course.id})` });
    }
  });
});

export type CourseAssessments = z.infer<typeof CourseAssessmentsSchema>;

export function validateCourseAssessments(course: Course, assessments: readonly Assessment[]): CourseAssessments {
  return CourseAssessmentsSchema.parse({ course, assessments });
}
