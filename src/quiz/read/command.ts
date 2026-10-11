import { SelectionStore, type SelectionPersistence } from '../../capture/selection-store.js';
import type { EdReader } from '../../capture/ed-capture.js';
import { CourseworkError, retryable } from '../../protocol/errors.js';
import { run, type Envelope } from '../../protocol/envelope.js';
import { targetSchema, validateTarget, type QuizTarget } from './contracts.js';
import { readSelectedQuiz } from './adapter.js';
import { normalizeQuiz, quizOutputSchema } from './questions.js';
import { openManagedQuizSession } from './session.js';
export interface QuizSession { transport: EdReader; close(): Promise<void> }
export interface QuizReadDependencies { store?: SelectionPersistence; openSession?: (target: QuizTarget) => Promise<QuizSession>; stdout?: (message: string) => void; stderr?: (message: string) => void }
function safeError(error: unknown): CourseworkError {
  const code = error instanceof CourseworkError && Object.hasOwn(retryable, error.code) ? error.code : 'SOURCE_UNAVAILABLE';
  return new CourseworkError(code, 'Quiz read could not complete.', code === 'LIMIT_EXCEEDED'
    ? 'Narrow the question selection with --question.' : 'Check selection, source structure and owner sign-in.');
}
/** Commander-independent handler; raw payloads never pass this boundary. */
export async function readQuiz(input: unknown, dependencies: QuizReadDependencies = {}): Promise<Envelope> {
  return run('quiz.read', async () => {
    let session: QuizSession | undefined;
    try {
      if (!targetSchema.safeParse(input).success) throw new CourseworkError('INVALID_INPUT', 'Invalid quiz target.');
      const loaded = await (dependencies.store ?? new SelectionStore()).load();
      if (loaded.status !== 'valid') throw new CourseworkError('INVALID_INPUT', 'Select courses in a terminal first.');
      const target = validateTarget(input, loaded.selection);
      session = await (dependencies.openSession ?? openManagedQuizSession)(target);
      return quizOutputSchema.parse(normalizeQuiz(await readSelectedQuiz(target, loaded.selection, session.transport)));
    } catch (error) { throw safeError(error); }
    finally {
      try { await session?.close(); }
      catch { throw safeError(undefined); }
    }
  });
}
export async function quizReadCommand(input: unknown, dependencies: QuizReadDependencies = {}): Promise<void> {
  const envelope = await readQuiz(input, dependencies);
  if (!envelope.ok) (dependencies.stderr ?? console.error)(`Quiz read failed: ${envelope.error.code}.`);
  (dependencies.stdout ?? console.log)(JSON.stringify(envelope));
}
