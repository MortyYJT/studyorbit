import { z } from 'zod';
import { validateSelection, type CaptureSelection } from '../../capture/selection-store.js';
import { CourseworkError } from '../../protocol/errors.js';
export const edId = z.string().regex(/^[1-9]\d{0,15}$/);
export const targetSchema = z.strictObject({ course: edId, lesson: edId,
  questions: z.array(z.string().regex(/^ed:[1-9]\d{0,15}:[1-9]\d{0,15}:[1-9]\d{0,15}:[1-9]\d{0,15}$/)).min(1).max(300).optional(),
});
export type QuizTarget = z.infer<typeof targetSchema>;
export function validateTarget(input: unknown, selection: CaptureSelection): QuizTarget {
  const parsed = targetSchema.safeParse(input);
  if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'Invalid quiz target.');
  const target = parsed.data;
  const courses = validateSelection(selection).courses;
  if (!courses.some(c => c.source === 'ed' && c.id === target.course)) {
    throw new CourseworkError('NOT_FOUND', 'Select the Ed course in a terminal first.');
  }
  if (target.questions && (new Set(target.questions).size !== target.questions.length
    || target.questions.some(ref => !ref.startsWith(`ed:${target.course}:${target.lesson}:`)))) {
    throw new CourseworkError('INVALID_INPUT', 'Question references must belong to the selected quiz.');
  }
  return target;
}
