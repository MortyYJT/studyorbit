import { z } from 'zod';
import type { EdReader } from '../../capture/ed-capture.js';
import type { CaptureSelection } from '../../capture/selection-store.js';
import { CourseworkError } from '../../protocol/errors.js';
import { edId, validateTarget, type QuizTarget } from './contracts.js';
const sourceId = z.union([edId, z.number().int().positive().safe().transform(String)]);
const list = z.object({ lessons: z.array(z.object({ id: sourceId, kind: z.string() })).max(300) });
const lessonSchema = z.object({ lesson: z.object({ id: sourceId, slides: z.array(z.object({ id: sourceId })).max(300) }) });
const slideSchema = z.object({ slide: z.object({ id: sourceId }) });
export interface QuizPayload { target: QuizTarget; lesson: unknown; slides: unknown[] }
export function sourceUnavailable(): CourseworkError {
  return new CourseworkError('SOURCE_UNAVAILABLE', 'Quiz source is unavailable or unsafe.', 'Check source structure and sign-in; no automatic retry was performed.');
}
/** Internal raw boundary only. Never return this payload from an agent handler. */
export async function readSelectedQuiz(input: unknown, selection: CaptureSelection, transport: EdReader): Promise<QuizPayload> {
  const target = validateTarget(input, selection);
  const read = async (endpoint: string): Promise<unknown> => {
    try {
      const response = await transport.read(endpoint);
      if (response.kind === 'auth' || response.status === 401 || response.status === 403) {
        throw new CourseworkError('AUTH_EXPIRED', 'Ed sign-in expired.');
      }
      if (response.kind !== 'json' || response.status !== 200) throw sourceUnavailable();
      return response.body;
    } catch (error) {
      if (error instanceof CourseworkError && error.code === 'AUTH_EXPIRED') throw new CourseworkError('AUTH_EXPIRED', 'Ed sign-in expired.');
      if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') throw new CourseworkError('LIMIT_EXCEEDED', 'Shared read budget exhausted.', 'Narrow the question selection.');
      throw sourceUnavailable();
    }
  };
  const discovered = list.safeParse(await read(`/api/courses/${target.course}/lessons`));
  if (!discovered.success) throw sourceUnavailable();
  if (!discovered.data.lessons.some(row => row.id === target.lesson && row.kind === 'attempt')) {
    throw new CourseworkError('NOT_FOUND', 'Selected attempt lesson was not discovered.');
  }
  const lesson = await read(`/api/lessons/${target.lesson}`);
  const parsed = lessonSchema.safeParse(lesson);
  if (!parsed.success || parsed.data.lesson.id !== target.lesson) throw sourceUnavailable();
  const ids = parsed.data.lesson.slides.map(slide => slide.id);
  if (new Set(ids).size !== ids.length) throw sourceUnavailable();
  const slides: unknown[] = [];
  // Narrowing selects only slide ids from validated discovery, never caller-supplied URLs.
  const requested = target.questions ? new Set(target.questions.map(ref => ref.split(':')[3])) : undefined;
  if (requested && [...requested].some(id => !ids.includes(id))) throw new CourseworkError('NOT_FOUND', 'Question slide was not referenced.');
  for (const id of ids) {
    if (requested && !requested.has(id)) continue;
    const body = await read(`/api/lessons/slides/${id}`);
    const slide = slideSchema.safeParse(body);
    if (!slide.success || slide.data.slide.id !== id) throw sourceUnavailable();
    slides.push(body);
  }
  return { target, lesson, slides };
}
