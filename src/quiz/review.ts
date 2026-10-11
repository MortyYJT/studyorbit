import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { CourseworkError } from '../protocol/errors.js';
import { run, type Envelope } from '../protocol/envelope.js';
import { QuizFiles } from './files.js';
import { bindingSchema, localId } from './policy.js';
import { edId } from './read/contracts.js';
import { FileEvidence } from './proposals.js';
import { answerSchema, hash, validateCitedAnswers, type TrustedSource } from './citations.js';
import { AuditTrail, safeQuizError, type AuditRefs } from './audit.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const validatedAnswer = answerSchema.extend({
  validatedCitations: z.array(answerSchema.shape.citations.element.extend({ offset: z.number().int().nonnegative(), end: z.number().int().positive(), sourceHash: digest, page: z.number().int().positive().optional() })),
  evidence: z.enum(['prompt-only', 'course-material']), limitation: z.string().optional(),
});
const recordSchema = z.strictObject({ version: z.literal(1), revision: z.uuid(), previousRevision: z.uuid().optional(), binding: bindingSchema,
  sourceRevision: digest, sourceHash: digest, answers: z.array(validatedAnswer).min(1).max(300), policyRef: digest, grantRef: digest, createdAt: z.iso.datetime() });
const pageSchema = z.strictObject({ course: edId.optional(), lesson: edId.optional(), pageId: localId, attemptId: edId.optional() });
const requestSchema = z.strictObject({ assessmentId: localId, revision: z.uuid(), page: pageSchema });
const approvalSchema = z.strictObject({ version: z.literal(1), status: z.literal('approved'), runId: z.uuid(), assessmentId: localId,
  revision: z.uuid(), proposalHash: digest, sourceRevision: digest, sourceHash: digest,
  page: pageSchema.extend({ course: edId, lesson: edId }), reviewedAt: z.iso.datetime() });
export type ReviewDecision = 'approve' | 'reject' | 'cancel';
export interface QuizReviewDependencies {
  files?: QuizFiles; audit?: AuditTrail; isTTY?: boolean; display?: (text: string) => void;
  decide?: (signal: AbortSignal) => Promise<ReviewDecision>;
  timeoutMs?: number; signal?: AbortSignal;
}
/** Only the full revision/hash approval phrase is consent; EOF and Ctrl-C cancel. */
export function terminalReviewDecision(revision: string, proposalHash: string, signal: AbortSignal,
  input: Readable = process.stdin, output: Writable = process.stderr): Promise<ReviewDecision> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve('cancel'); return; }
    const terminal = createInterface({ input, output, terminal: true });
    const finish = (decision: ReviewDecision) => {
      signal.removeEventListener('abort', cancel); terminal.removeListener('SIGINT', cancel); terminal.removeListener('close', cancel);
      input.removeListener('end', cancel); input.removeListener('error', cancel);
      terminal.removeListener('line', line); terminal.close(); resolve(decision);
    };
    const cancel = () => finish('cancel');
    const line = (value: string) => finish(value === `APPROVE ${revision} ${proposalHash}` ? 'approve' : value === 'REJECT' ? 'reject' : 'cancel');
    signal.addEventListener('abort', cancel, { once: true }); terminal.once('SIGINT', cancel); terminal.once('close', cancel); terminal.once('line', line);
    // readline emits a buffered partial line on EOF; cancel before that can become consent.
    input.prependOnceListener('end', cancel); input.once('error', cancel);
    terminal.setPrompt(`Type APPROVE ${revision} ${proposalHash} to approve, REJECT to reject, or Ctrl-C to cancel: `); terminal.prompt();
  });
}
async function decision(dependencies: QuizReviewDependencies, record: z.infer<typeof recordSchema>): Promise<NonNullable<AuditRefs['reviewStatus']>> {
  const controller = new AbortController(); let status: 'cancelled' | 'timed-out' = 'cancelled';
  let finish!: (value: 'cancel') => void;
  const interrupted = new Promise<'cancel'>(resolve => { finish = resolve; });
  const cancel = () => { controller.abort(); finish('cancel'); };
  const timeout = setTimeout(() => { status = 'timed-out'; cancel(); }, dependencies.timeoutMs ?? 5 * 60 * 1000);
  dependencies.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (dependencies.signal?.aborted) cancel();
    const value = controller.signal.aborted ? 'cancel' : await Promise.race([interrupted,
      (dependencies.decide ?? (signal => terminalReviewDecision(record.revision, hash(record), signal)))(controller.signal)]);
    if (controller.signal.aborted) return status;
    return value === 'approve' ? 'approved' : value === 'reject' ? 'rejected' : 'cancelled';
  } finally { clearTimeout(timeout); dependencies.signal?.removeEventListener('abort', cancel); controller.abort(); }
}
function conflict(): never { throw new CourseworkError('CONFLICT', 'Quiz review is stale; read and review the current revision again.'); }
async function load(request: z.infer<typeof requestSchema>, files: QuizFiles) {
  const current = recordSchema.safeParse(await files.read(`proposal-${hash(request.assessmentId)}`));
  const saved = recordSchema.safeParse(await files.read(`revision-${request.revision}`));
  if (!current.success || !saved.success || current.data.revision !== request.revision || current.data.binding.assessmentId !== request.assessmentId
    || hash(current.data) !== hash(saved.data)) return conflict();
  const record = saved.data; const { binding } = record;
  if (request.page.course !== undefined && request.page.course !== binding.course || request.page.lesson !== undefined && request.page.lesson !== binding.lesson) return conflict();
  const evidence = new FileEvidence(files); const snapshot = await evidence.read(`ed:${binding.course}:${binding.lesson}`);
  const questions: TrustedSource[] = snapshot.data.sources.map(s => ({ ...s, kind: 'question', questionRef: s.sourceItemId }));
  const materials = await evidence.materials(record.answers.flatMap(a => a.citations.map(c => c.sourceItemId)).filter(id => !questions.some(s => s.sourceItemId === id)), binding.course);
  if (snapshot.sourceRevision !== record.sourceRevision || hash([...questions, ...materials]) !== record.sourceHash) return conflict();
  const answers = record.answers.map(({ validatedCitations: _citations, evidence: _evidence, limitation: _limitation, ...answer }) => answer);
  if (hash(validateCitedAnswers(answers, snapshot.data.questions.filter(q => q.supported).map(q => q.ref), [...questions, ...materials])) !== hash(record.answers)) return conflict();
  return { record, snapshot, page: { ...request.page, course: binding.course, lesson: binding.lesson } };
}
export type ReviewedQuizRevision = Awaited<ReturnType<typeof load>>;
async function reload(request: z.infer<typeof requestSchema>, files: QuizFiles): Promise<ReviewedQuizRevision> {
  try { return await load(request, files); }
  catch (error) {
    if (error instanceof CourseworkError && ['CONFLICT', 'CITATION_MISMATCH', 'SOURCE_UNAVAILABLE'].includes(error.code)) return conflict();
    throw safeQuizError(error);
  }
}
/** D must supply identities from its verified open page and recheck current policy/L3 grant.
 * Keep its mutations inside this callback to exclude competing cooperative local writers.
 * This guard grants no authorization and performs no browser operation.
 */
export async function withReviewedRevision<T>(input: unknown, action: (reviewed: ReviewedQuizRevision) => Promise<T>, files = new QuizFiles()): Promise<T> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || parsed.data.page.course === undefined || parsed.data.page.lesson === undefined) throw new CourseworkError('INVALID_INPUT', 'Verified target identity is required.');
  return files.exclusive(async () => {
    const request = parsed.data;
    const approval = approvalSchema.safeParse(await files.read(`review-${hash(request.assessmentId)}`));
    if (!approval.success) throw new CourseworkError('INVALID_INPUT', 'Explicit terminal approval is required.');
    if (approval.data.assessmentId !== request.assessmentId || approval.data.revision !== request.revision || hash(approval.data.page) !== hash(request.page)) return conflict();
    const loaded = await reload(request, files);
    if (approval.data.proposalHash !== hash(loaded.record) || approval.data.sourceRevision !== loaded.record.sourceRevision || approval.data.sourceHash !== loaded.record.sourceHash
      || hash(await files.read(`binding-${hash(request.assessmentId)}`)) !== hash(loaded.record.binding)) return conflict();
    return action(loaded);
  });
}
/** Read-only convenience; D uses withReviewedRevision for preflight plus mutation. */
export async function reviewedRevisionPreflight(input: unknown, files = new QuizFiles()): Promise<ReviewedQuizRevision> {
  return withReviewedRevision(input, async reviewed => reviewed, files);
}
// Quote untrusted text: terminal control sequences cannot hide or replace review content.
const quoted = (value: unknown) => JSON.stringify(value).replace(/\p{Cf}/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
function render(loaded: Awaited<ReturnType<typeof load>>): string {
  const { record, snapshot, page } = loaded;
  const lines = [`Target: ${quoted(record.binding)}`, `Page identity: ${quoted(page)}`, `Revision: ${record.revision}`, `Proposal hash: ${hash(record)}`, `Source revision: ${record.sourceRevision}`, `Source hash: ${record.sourceHash}`, `Coverage: ${quoted(snapshot.data.coverage)}`];
  for (const question of snapshot.data.questions) {
    lines.push(`Question: ${question.ref}`);
    if (!question.supported) { lines.push('unsupported: unfillable question'); continue; }
    lines.push(`Prompt: ${quoted(question.prompt)}`, `Options: ${quoted(question.options ?? [])}`);
    const answer = record.answers.find(a => a.questionRef === question.ref);
    if (!answer) { lines.push('Missing proposed answer'); continue; }
    lines.push(`Answer: ${quoted(answer.answer)}`, `Rationale: ${quoted(answer.rationale)}`, `Evidence: ${answer.evidence}`);
    if (answer.limitation) lines.push(`Limitation: ${quoted(answer.limitation)}`);
    for (const citation of answer.validatedCitations) lines.push(`Citation: ${quoted(citation)}`);
  }
  return lines.join('\n');
}
export async function reviewQuiz(input: unknown, dependencies: QuizReviewDependencies = {}): Promise<Envelope> {
  const runId = randomUUID(); const refs: AuditRefs = {};
  let files = dependencies.files; const getFiles = () => files ??= new QuizFiles();
  const audit = dependencies.audit ?? new AuditTrail(line => getFiles().append('audit', line));
  let completed = false;
  const result = await run('quiz.review', async () => {
    try {
      await audit.record('review', 'intent', runId, 'OK');
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success || dependencies.timeoutMs !== undefined && (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 30 * 60 * 1000)) throw new CourseworkError('INVALID_INPUT', 'Invalid quiz review request.');
      const request = parsed.data;
      if (!(dependencies.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true))) throw new CourseworkError('INVALID_INPUT', 'Review requires an owner terminal.');
      const name = `review-${hash(request.assessmentId)}`;
      const loaded = await getFiles().exclusive(async () => {
        const loaded = await load(request, getFiles());
        Object.assign(refs, { assessmentRef: loaded.snapshot.data.assessmentRef, revision: loaded.record.revision, policyRef: loaded.record.policyRef, grantRef: loaded.record.grantRef });
        // Invalidate any earlier approval before waiting; interrupted reviews fail closed.
        await getFiles().write(name, { version: 1, status: 'pending', runId });
        return loaded;
      });
      (dependencies.display ?? (text => process.stderr.write(text + '\n')))(render(loaded));
      let status = await decision(dependencies, loaded.record);
      return await getFiles().exclusive(async () => {
        const current = await reload(request, getFiles());
        if (hash(current.record) !== hash(loaded.record)) return conflict();
        const pending = await getFiles().read(name);
        if (!pending || hash(pending) !== hash({ version: 1, status: 'pending', runId })) return conflict();
        if (dependencies.signal?.aborted) status = 'cancelled';
        // Confirmation is intent, not a claim that approval has already been saved.
        await audit.record('review', 'intent', runId, 'OK', { ...refs, reviewStatus: status });
        if (dependencies.signal?.aborted) status = 'cancelled';
        const record = { version: 1, status, runId, assessmentId: request.assessmentId, revision: loaded.record.revision,
          proposalHash: hash(loaded.record), sourceRevision: loaded.record.sourceRevision, sourceHash: loaded.record.sourceHash,
          page: loaded.page, reviewedAt: new Date().toISOString() };
        // Even without an external signal, use the durable activation path.
        const signal = dependencies.signal ?? new AbortController().signal;
        try { await getFiles().write(name, record, status === 'approved' ? signal : undefined); }
        catch (error) {
          if (status !== 'approved' || !signal.aborted || !(error instanceof Error) || error.name !== 'AbortError') throw error;
          status = 'cancelled';
          await getFiles().write(name, { ...record, status });
        }
        refs.reviewStatus = status;
        try { await audit.record('review', 'outcome', runId, 'OK', refs); completed = true; }
        catch (error) {
          // Preserve the existing fail-closed contract for completion-audit failures.
          delete refs.reviewStatus;
          await getFiles().write(name, { version: 1, status: 'pending', runId });
          throw error;
        }
        return { status, revision: loaded.record.revision };
      });
    } catch (error) { throw safeQuizError(error); }
  });
  result.meta.runId = runId;
  if (!result.ok || !completed) {
    try { await audit.record('review', !result.ok && result.error.code === 'INVALID_INPUT' ? 'denial' : 'outcome', runId, result.ok ? 'OK' : result.error.code, refs); }
    catch (error) { const failure = await run('quiz.review', () => { throw safeQuizError(error); }); failure.meta.runId = runId; return failure; }
  }
  return result;
}
