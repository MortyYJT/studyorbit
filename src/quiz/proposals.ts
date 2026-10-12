import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { enforceAuthorization } from '../protocol/authorization-rules.js';
import { CourseworkError } from '../protocol/errors.js';
import { RunSchema } from '../domain/schemas.js';
import { run, type Envelope, type FailureEnvelope } from '../protocol/envelope.js';
import { AuditTrail, auditedMutation, assessmentRefSchema } from './audit.js';
import { QuizFiles } from './files.js';
import { authorize, bindingSchema, grantSchema, policySchema, prerequisiteSchema, invalidAuthorization, verifyRealPrerequisites, validatePolicy } from './policy.js';
import { answerSchema, hash, trustedSourceSchema, validateCitedAnswers, type TrustedSource } from './citations.js';
import { quizOutputSchema, type QuizReadData } from './read/questions.js';
import type { QuizTarget } from './read/contracts.js';
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const proposalSchema = z.strictObject({ version: z.literal(1), binding: bindingSchema, sourceRevision: revisionSchema, answers: z.array(answerSchema).min(1).max(300) });
export interface QuizWriteDependencies { files?: QuizFiles; audit?: AuditTrail; isTTY?: boolean; confirm?: (message: string) => Promise<boolean> }
async function terminalConfirm(message: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await terminal.question(`${message}\nType RECORD to confirm: `)).trim() === 'RECORD'; }
  finally { terminal.close(); }
}
function context(dependencies: QuizWriteDependencies) {
  // Delay path access until inside the audited boundary, so configuration errors remain sanitized.
  let files: QuizFiles | undefined = dependencies.files;
  const getFiles = () => files ??= new QuizFiles();
  return { getFiles, audit: dependencies.audit ?? new AuditTrail(line => getFiles().append('audit', line)) };
}
/** File decoding fails before a validated handler; retain its safe run identity and outcome. */
export async function recordInputFailure(kind: 'policy' | 'grant' | 'prerequisites' | 'propose', failure: FailureEnvelope, dependencies: QuizWriteDependencies): Promise<Envelope> {
  const { getFiles, audit } = context(dependencies);
  try {
    await audit.record(kind === 'propose' ? 'proposal' : kind, 'outcome', failure.meta.runId, failure.error.code);
    if (kind === 'propose') await recordProposalRun(getFiles(), failure, new Date().toISOString());
    return failure;
  } catch {
    const result = await run(failure.command, () => { throw new CourseworkError('INTERNAL', 'Quiz failure recording is unavailable.'); });
    result.meta.runId = failure.meta.runId; return result;
  }
}
async function recordProposalRun(files: QuizFiles, result: Envelope, startedAt: string): Promise<void> {
  await files.append('runs', JSON.stringify(RunSchema.parse({ id: result.meta.runId, command: 'quiz.propose', startedAt, endedAt: new Date().toISOString(), steps: result.ok ? 1 : 0,
    outcome: result.ok ? 'ok' : 'error', ...(!result.ok ? { errorCode: result.error.code } : {}) })) + '\n');
}
export class FileEvidence {
  constructor(private readonly files: QuizFiles) {}
  async saveRead(input: unknown): Promise<string> {
    const data = quizOutputSchema.parse(input); this.checkRead(data);
    const sourceRevision = hash(data);
    await this.files.write(`read-${hash(data.assessmentRef)}`, { version: 1, sourceRevision, data });
    return sourceRevision;
  }
  private checkRead(data: QuizReadData): void {
    if (!assessmentRefSchema.safeParse(data.assessmentRef).success || new Set(data.questions.map(q => q.ref)).size !== data.questions.length
      || data.questions.some(q => !q.ref.startsWith(`${data.assessmentRef}:`))
      || new Set(data.sources.map(s => s.sourceItemId)).size !== data.sources.length
      || data.sources.some(s => !data.questions.some(q => q.supported && q.ref === s.sourceItemId) || s.locator !== `question:${s.sourceItemId.split(':').at(-1)}`)
      || data.questions.some(q => q.supported && !data.sources.some(s => s.sourceItemId === q.ref))) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Trusted quiz snapshot is unavailable.');
  }
  async read(assessmentRef: string) {
    const result = z.strictObject({ version: z.literal(1), sourceRevision: revisionSchema, data: quizOutputSchema }).safeParse(await this.files.read(`read-${hash(assessmentRef)}`));
    if (!result.success || result.data.data.assessmentRef !== assessmentRef || hash(result.data.data) !== result.data.sourceRevision) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Read the quiz before proposing answers.');
    this.checkRead(result.data.data); return result.data;
  }
  async materials(ids: readonly string[], course: string): Promise<TrustedSource[]> {
    const sources: TrustedSource[] = [];
    // Inspect all trusted local material for this course, including sources omitted by a proposal.
    for (const name of await this.files.records('material-')) {
      const result = z.strictObject({ version: z.literal(1), course: z.string(), redacted: z.literal(true), source: trustedSourceSchema }).safeParse(await this.files.read(name));
      if (!result.success || name !== `material-${hash(result.data.source.sourceItemId)}` || result.data.source.kind !== 'material') throw new CourseworkError('CITATION_MISMATCH', 'Trusted course-material citation is unavailable.');
      if (result.data.course !== course) continue;
      sources.push(result.data.source);
    }
    if (ids.some(id => !sources.some(source => source.sourceItemId === id))) throw new CourseworkError('CITATION_MISMATCH', 'Trusted course-material citation is unavailable.');
    return sources;
  }
}
export async function checkRealQuizPrerequisites(target: QuizTarget, files = new QuizFiles()): Promise<void> {
  verifyRealPrerequisites({ course: target.course, lesson: target.lesson }, await files.read(`policy-${target.course}`), await files.read(`prerequisites-${hash(`ed:${target.course}:${target.lesson}`)}`));
}
export async function recordOwnerAction(kind: 'policy' | 'grant' | 'prerequisites', input: unknown, dependencies: QuizWriteDependencies = {}): Promise<Envelope> {
  const { getFiles, audit } = context(dependencies);
  return auditedMutation(kind, audit, async refs => getFiles().exclusive(async () => {
    const parsed = (kind === 'policy' ? policySchema : kind === 'grant' ? grantSchema : prerequisiteSchema).safeParse(input);
    if (!parsed.success) return invalidAuthorization();
    if (!(dependencies.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true))) return invalidAuthorization();
    if (!await (dependencies.confirm ?? terminalConfirm)(`Record ${kind}: ${JSON.stringify(parsed.data, null, 2)}`)) return invalidAuthorization();
    const record = parsed.data;
    if (kind === 'policy' && 'course' in record) {
      refs.policyRef = hash(record); await getFiles().write(`policy-${record.course}`, record);
    } else if ('binding' in record) {
      const { binding } = record; refs.assessmentRef = `ed:${binding.course}:${binding.lesson}`;
      const previous = await getFiles().read(`binding-${hash(binding.assessmentId)}`);
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new CourseworkError('CONFLICT', 'Assessment binding is already recorded differently.');
      const rawPolicy = await getFiles().read(`policy-${binding.course}`);
      const policy = rawPolicy === undefined ? undefined : validatePolicy(rawPolicy);
      if (policy) refs.policyRef = hash(rawPolicy);
      if (kind === 'grant' && 'level' in record) {
        enforceAuthorization(record.level, { courseId: binding.course, assessmentId: binding.assessmentId, category: binding.category },
          policy ? { ...policy, courseId: policy.course } : undefined,
          { courseId: binding.course, assessmentId: binding.assessmentId, category: binding.category, level: record.level });
        refs.grantRef = hash(record); await getFiles().write(`grant-${hash(binding.assessmentId)}`, record);
      } else {
        verifyRealPrerequisites({ course: binding.course, lesson: binding.lesson }, policy, record);
        await getFiles().write(`prerequisites-${hash(refs.assessmentRef)}`, record);
      }
      await getFiles().write(`binding-${hash(binding.assessmentId)}`, binding);
    } else return invalidAuthorization();
    return { recorded: kind };
  }));
}
export async function proposeQuiz(input: unknown, dependencies: QuizWriteDependencies = {}): Promise<Envelope> {
  const { getFiles, audit } = context(dependencies); const startedAt = new Date().toISOString();
  const result = await auditedMutation('proposal', audit, async refs => getFiles().exclusive(async () => {
    const parsed = proposalSchema.safeParse(input);
    if (!parsed.success) {
      // Malformed citation metadata is a citation failure, while malformed target references are input failures.
      const target = z.object({ version: z.literal(1), binding: bindingSchema, sourceRevision: revisionSchema }).safeParse(input);
      if (target.success && typeof input === 'object' && input && 'answers' in input && !z.array(answerSchema).min(1).max(300).safeParse(input.answers).success) throw new CourseworkError('CITATION_MISMATCH', 'Citation input is invalid.');
      throw new CourseworkError('INVALID_INPUT', 'Invalid quiz proposal.');
    }
    const { binding, answers, sourceRevision } = parsed.data;
    const recordedBinding = bindingSchema.safeParse(await getFiles().read(`binding-${hash(binding.assessmentId)}`));
    if (!recordedBinding.success || JSON.stringify(recordedBinding.data) !== JSON.stringify(binding)) return invalidAuthorization();
    refs.assessmentRef = `ed:${binding.course}:${binding.lesson}`;
    const policy = await getFiles().read(`policy-${binding.course}`); const grant = await getFiles().read(`grant-${hash(binding.assessmentId)}`);
    authorize(policy, grant, binding, 2); refs.policyRef = hash(policy); refs.grantRef = hash(grant);
    const evidence = new FileEvidence(getFiles()); const snapshot = await evidence.read(refs.assessmentRef);
    if (snapshot.sourceRevision !== sourceRevision) throw new CourseworkError('CONFLICT', 'Quiz sources changed; read the quiz again.');
    const questions = snapshot.data.questions.filter(q => q.supported).map(q => q.ref);
    const questionSources: TrustedSource[] = snapshot.data.sources.map(s => ({ ...s, kind: 'question', questionRef: s.sourceItemId }));
    const materialIds = answers.flatMap(a => [...a.citations.map(c => c.sourceItemId), ...a.statements.flatMap(s => s.kind === 'material' ? [s.sourceItemId] : [])]).filter(id => !questionSources.some(s => s.sourceItemId === id));
    const materials = await evidence.materials(materialIds, binding.course);
    const validated = validateCitedAnswers(answers, questions, [...questionSources, ...materials]);
    const revision = randomUUID(); const previous = await getFiles().read(`proposal-${hash(binding.assessmentId)}`);
    const previousRevision = z.object({ revision: z.uuid() }).safeParse(previous);
    const record = { version: 1, revision, ...(previousRevision.success ? { previousRevision: previousRevision.data.revision } : {}), binding, sourceRevision,
      sourceHash: hash([...questionSources, ...materials]), answers: validated, policyRef: refs.policyRef, grantRef: refs.grantRef, createdAt: new Date().toISOString() };
    refs.revision = revision;
    await getFiles().write(`revision-${revision}`, record);
    await getFiles().write(`proposal-${hash(binding.assessmentId)}`, record);
    return { assessmentRef: refs.assessmentRef, revision, sourceRevision, evidence: validated.map(a => a.evidence) };
  }));
  try {
    await recordProposalRun(getFiles(), result, startedAt);
  } catch {
    return { protocol: result.protocol, command: result.command, meta: result.meta, ok: false,
      error: { code: 'INTERNAL', message: 'Quiz run recording is unavailable; inspect local state before retrying.', retryable: false } };
  }
  return result;
}
