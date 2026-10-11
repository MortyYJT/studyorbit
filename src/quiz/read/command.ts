import { AuditTrail } from '../audit.js';
import { QuizFiles } from '../files.js';
import { FileEvidence, checkRealQuizPrerequisites } from '../proposals.js';
import { hash } from '../citations.js';
import { SelectionStore, type SelectionPersistence } from '../../capture/selection-store.js';
import type { EdReader } from '../../capture/ed-capture.js';
import { CourseworkError, retryable } from '../../protocol/errors.js';
import { run, type Envelope } from '../../protocol/envelope.js';
import { targetSchema, validateTarget, type QuizTarget } from './contracts.js';
import { readSelectedQuiz } from './adapter.js';
import { normalizeQuiz, quizOutputSchema } from './questions.js';
import { openManagedQuizSession } from './session.js';
export interface QuizSession { transport: EdReader; close(): Promise<void> }
export interface QuizReadDependencies { files?: QuizFiles; audit?: AuditTrail; store?: SelectionPersistence; openSession?: (target: QuizTarget) => Promise<QuizSession>; stdout?: (message: string) => void; stderr?: (message: string) => void }
function safeError(error: unknown): CourseworkError {
  const code = error instanceof CourseworkError && Object.hasOwn(retryable, error.code) ? error.code : 'SOURCE_UNAVAILABLE';
  return new CourseworkError(code, 'Quiz read could not complete.', code === 'LIMIT_EXCEEDED'
    ? 'Narrow the question selection with --question.' : 'Check selection, source structure and owner sign-in.');
}
/** Commander-independent handler; raw payloads never pass this boundary. */
export async function readQuiz(input: unknown, dependencies: QuizReadDependencies = {}): Promise<Envelope> {
  let assessmentRef: string | undefined;
  let files = dependencies.files;
  const audit = dependencies.audit ?? new AuditTrail(line => (files ??= new QuizFiles()).append('audit', line));
  let envelope = await run('quiz.read', async () => {
    let session: QuizSession | undefined;
    try {
      if (!targetSchema.safeParse(input).success) throw new CourseworkError('INVALID_INPUT', 'Invalid quiz target.');
      const loaded = await (dependencies.store ?? new SelectionStore()).load();
      if (loaded.status !== 'valid') throw new CourseworkError('INVALID_INPUT', 'Select courses in a terminal first.');
      const target = validateTarget(input, loaded.selection);
      session = await (dependencies.openSession ?? (t => openManagedQuizSession(t, {
        verifyPrerequisites: async verified => checkRealQuizPrerequisites(verified, files ??= new QuizFiles()),
      })))(target);
      const data = quizOutputSchema.parse(normalizeQuiz(await readSelectedQuiz(target, loaded.selection, session.transport)));
      assessmentRef = data.assessmentRef;
      return { ...data, sourceRevision: hash(data) };
    } catch (error) { throw safeError(error); }
    finally {
      try { await session?.close(); }
      catch { throw safeError(undefined); }
    }
  });
  // Persist only a successful bounded read after session cleanup, with intent before any snapshot write.
  if (envelope.ok && files) {
    const runId = envelope.meta.runId; const data = envelope.data; const storage = files;
    const saved = await run('quiz.read', async () => {
      await audit.record('read', 'intent', runId, 'OK', assessmentRef ? { assessmentRef } : {});
      const { sourceRevision: _revision, ...snapshot } = data as Record<string, unknown>;
      try { await storage.exclusive(async () => new FileEvidence(storage).saveRead(snapshot)); }
      catch { throw new CourseworkError('INTERNAL', 'Trusted quiz snapshot storage is unavailable.'); }
      return data;
    });
    if (!saved.ok) { saved.meta = envelope.meta; envelope = saved; }
  }
  try { await audit.record('read', 'outcome', envelope.meta.runId, envelope.ok ? 'OK' : envelope.error.code, assessmentRef ? { assessmentRef } : {}); }
  catch {
    const failure = await run('quiz.read', () => { throw new CourseworkError('INTERNAL', 'Quiz auditing is unavailable.'); });
    failure.meta.runId = envelope.meta.runId; return failure;
  }
  return envelope;
}
export async function quizReadCommand(input: unknown, dependencies: QuizReadDependencies = {}): Promise<void> {
  const envelope = await readQuiz(input, dependencies);
  if (!envelope.ok) (dependencies.stderr ?? console.error)(`Quiz read failed: ${envelope.error.code}.`);
  (dependencies.stdout ?? console.log)(JSON.stringify(envelope));
}
