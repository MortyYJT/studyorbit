import type { Repository } from '../store/repository.js';
import { CourseworkError } from '../protocol/errors.js';

export const presets = Object.freeze([
  { id: 'complete-assessment', assessment: true, template: 'Complete the assessment' },
  { id: 'explain-assessment', assessment: true, template: 'Explain the assessment requirements' },
  { id: 'fill-course-information', assessment: false, template: 'Fill in missing course information with cited annotations' },
  { id: 'estimate-work', assessment: true, template: 'Estimate the work with a reason' },
  { id: 'prepare-revision', assessment: false, template: 'Prepare revision using skills/revision' },
  { id: 'tutor-revision', assessment: false, template: 'Tutor me using skills/revision' },
  { id: 'wrong-answers-only', assessment: false, template: 'Practise wrong answers only using skills/revision' },
  { id: 'review-pending', assessment: false, template: 'Review the pending needs-you item in this context' },
]);
export interface ConversationInput { title?: string; courseId?: string; assessmentId?: string; preset?: string }
export function renderPreset(store: Pick<Repository, 'loadCourse' | 'loadAssessment'>, input: ConversationInput): string | undefined {
  const course = input.courseId ? store.loadCourse(input.courseId) : undefined;
  const assessment = input.assessmentId ? store.loadAssessment(input.assessmentId) : undefined;
  if (input.courseId && !course || input.assessmentId && (!assessment || assessment.courseId !== course?.id)) {
    throw new CourseworkError('INVALID_INPUT', 'Invalid conversation context.');
  }
  if (!input.preset) return undefined;
  const preset = presets.find(p => p.id === input.preset);
  if (!preset || !course || preset.assessment && !assessment || assessment?.kind === 'exam') {
    throw new CourseworkError('INVALID_INPUT', 'Preset unavailable for this context.');
  }
  return `${preset.template}. Course ${JSON.stringify({ id: course.id, title: course.name })}${assessment ? `; assessment ${JSON.stringify({ id: assessment.id, title: assessment.name })}` : ''}.`;
}
