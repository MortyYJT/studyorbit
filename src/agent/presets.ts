import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repository } from '../store/repository.js';
import type { CurrentStateReader } from '../store/queries.js';
import { CourseworkError } from '../protocol/errors.js';
import { AssessmentAutonomy } from '../protocol/autonomy.js';
import { packageRoot } from '../config/data-dir.js';

/** The skill text a preset's agent prompt carries, or '' when none applies. */
export function presetSkill(preset?: string): string {
  const name = ['prepare-revision', 'tutor-revision', 'wrong-answers-only'].includes(preset ?? '') ? 'revision'
    : ['complete-assessment', 'explain-assessment', 'estimate-work'].includes(preset ?? '') ? 'assessment' : undefined;
  return name ? readFileSync(join(packageRoot(), 'skills', name, 'SKILL.md'), 'utf8') : '';
}

export const presets = Object.freeze([
  { id: 'start-assessment', assessment: true, template: 'Start the assessment' },
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

/** Reads the same stored authority as `autonomy.read`, without writing an audit event for a preset preview. */
type PresetStore = Pick<Repository, 'loadCourse' | 'loadAssessment' | 'readAnnotations' | 'appendAnnotation'
  | 'readCourseAutonomy' | 'appendCourseAutonomy' | 'readAssessmentLinks' | 'loadSourceItem'>
  & Partial<Pick<CurrentStateReader, 'query'>>;

export function renderPreset(store: PresetStore, input: ConversationInput): string | undefined {
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
  const identity = `Course ${JSON.stringify({ id: course.id, title: course.name })}${assessment ? `; assessment ${JSON.stringify({ id: assessment.id, title: assessment.name })}` : ''}.`;
  if (preset.id === 'start-assessment' && assessment) {
    if (assessment.kind === 'quiz') {
      const url = quizUrl(store, assessment.id);
      const level = grantedLevel(store, course.id, assessment.id);
      return `Start the quiz ${JSON.stringify({ id: assessment.id, title: assessment.name })} at ${url ?? 'the quiz page stored on its Canvas source'}. `
        + `The granted level is ${level === undefined ? 'unknown; read autonomy.read before acting' : `L${level}`}. Stay within it and never press a final submit. ${identity}`;
    }
    return `Start the assessment ${JSON.stringify({ id: assessment.id, title: assessment.name })}. `
      + `Call assessment.files for this assessment, then record its requirements and rubric points as annotations citing the SourceItems it returns. ${identity}`;
  }
  return `${preset.template}. ${identity}`;
}

/** The assessment's Canvas SourceItem URL, newest link first. */
function quizUrl(store: PresetStore, assessmentId: string): string | undefined {
  const links = store.readAssessmentLinks(assessmentId);
  for (let index = links.length - 1; index >= 0; index--) {
    const source = store.loadSourceItem(links[index]!.sourceItemId);
    if (source?.platform === 'canvas' && source.url) return source.url;
  }
  return undefined;
}

/** The same effective level `autonomy.read` would report for this assessment. */
function grantedLevel(store: PresetStore, courseId: string, assessmentId: string): number | undefined {
  if (!store.query) return undefined;
  try {
    const read = new AssessmentAutonomy(store, { record: async () => {} }).read({ courseId });
    const target = read.assessments.find(assessment => assessment.assessmentId === assessmentId);
    return target?.effectiveLevel ?? undefined;
  } catch {
    return undefined;
  }
}
