/** Synthetic-only contract fixtures and in-memory ports for M3. Never mount as production services. */
import { randomUUID } from 'node:crypto';
import { contracts, type CommandName, type CommandInput, type CommandOutput, type ParsedCommandInput,
  type FilledTarget, type Confirmation } from './contracts.js';
import { createRegistry } from './registry.js';
import type { TrustedContext, AuditEvent, ReadCommand, WriteCommand, ProtocolRepository, ProtocolServices, ConfirmationService, ServiceInput } from './context.js';
import { CourseworkError } from './errors.js';
import { createRedactor } from '../sync/redaction.js';

const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const digest = 'a'.repeat(64);
const at = '2026-01-01T00:00:00Z';
const binding = { assessmentId: 'synthetic-assessment', course: '7', lesson: '11', category: 'assignment' as const };
const citation = { sourceItemId: 'synthetic-source', quote: 'Read the synthetic guide.', locator: 'page:1' };
const verified = { ...citation, offset: 0, end: 25, sourceHash: digest, page: 1 };
const source = { sourceItemId: citation.sourceItemId, courseId: 'synthetic-course', text: citation.quote,
  sourceHash: digest, locator: citation.locator, page: 1, provenance: 'manual' as const, redacted: true as const };
const course = { id: 'synthetic-course', moduleId: 'synthetic-module', code: 'SYN10001', name: 'Synthetic course', term: 'Synthetic term', assessmentsComplete: false };
const assessment = { id: binding.assessmentId, courseId: course.id, name: 'Synthetic assessment', kind: 'assignment' as const,
  weight: 10, isFinal: false, status: 'not_started' as const };
const task = { id: 'synthetic-task', moduleId: course.moduleId, courseId: course.id, assessmentId: assessment.id,
  title: 'Read instructions', source: 'coursework' as const, steps: [{ title: 'Read the synthetic guide.', estimateMinutes: 15, done: false, citations: [citation] }] };
const claim = { text: 'Read the synthetic guide.', citations: [citation] };
const study = { courseId: course.id, week: 1, sourceRevision: digest };
const receipt = { id: 'synthetic-record', revision, sourceRevision: digest, citations: [verified], limitations: ['Citation membership does not establish correctness.'] };
const note = { ...receipt, ...study, claims: [claim] };
const practiceQuestion = { id: 'synthetic-question', prompt: 'What should you read?', kind: 'open' as const,
  answer: 'The synthetic guide.', explanation: [claim] };
const practice = { ...receipt, ...study, questions: [practiceQuestion] };
const questionRef = 'ed:7:11:13:17';
const quizCitation = { sourceItemId: questionRef, quote: 'What is two plus two?', locator: `question:${questionRef}` };
const answer = { questionRef, answer: '4', rationale: 'Two plus two equals four.', citations: [quizCitation],
  statements: [{ field: 'answer' as const, text: '4', kind: 'reasoning' as const },
    { field: 'rationale' as const, text: 'Two plus two equals four.', kind: 'reasoning' as const }] };
const proposal = { version: 1 as const, binding, sourceRevision: digest, answers: [answer] };
const proposalRecord = { ...proposal, revision, sourceHash: digest, policyRef: digest, grantRef: digest, createdAt: at,
  answers: [{ ...answer, validatedCitations: [{ ...quizCitation, offset: 0, end: 21, sourceHash: digest }],
    evidence: 'prompt-only' as const, limitation: 'Only the question is cited.' }] };
const policy = { version: 1 as const, courseId: course.id, status: 'owner-attested' as const,
  attestation: 'Synthetic fixture only.', date: '2026-01-01', cap: 4 as const };
const grant = { version: 1 as const, courseId: course.id, assessmentId: assessment.id, category: 'assignment' as const, level: 4 as const, date: '2026-01-01' };
const filled: FilledTarget = { assessmentId: assessment.id, revision, sourceRevision: digest,
  page: { course: '7', lesson: '11', pageId: 'synthetic-page', attemptId: '19' }, policyRef: digest, grantRef: digest, filledRevision: revision };
const { filledRevision: _filledRevision, ...fillInput } = filled;
function page<T>(item: T) { return { items: [item], evidence: [source], coverage: { complete: false, gaps: [{ code: 'INCOMPLETE' as const }] } }; }
export const examples = {
  'courses.list': { input: { limit: 10 }, output: page(course) },
  'assessments.list': { input: { courseId: course.id, limit: 10 }, output: page(assessment) },
  'tasks.list': { input: { courseId: course.id, limit: 10 }, output: page(task) },
  'sources.get': { input: { sourceItemId: source.sourceItemId }, output: source },
  'materials.list': { input: { courseId: course.id, limit: 10 }, output: page(source) },
  changes: { input: { since: 0, limit: 10 }, output: { changes: [], nextCursor: 0 } },
  'runs.list': { input: { limit: 10 }, output: page({ id: revision, command: 'synthetic', startedAt: at, endedAt: at, steps: 0, outcome: 'ok' as const }) },
  'revision.list': { input: { courseId: study.courseId, week: study.week, limit: 10 }, output: page(note) },
  'practice.list': { input: { courseId: study.courseId, week: study.week, limit: 10 }, output: page(practice) },
  'proposals.get': { input: { assessmentId: assessment.id, revision }, output: proposalRecord },
  'breakdown.write': { input: { assessmentId: assessment.id, sourceRevision: digest, task }, output: receipt },
  'revision.write': { input: { ...study, claims: [claim] }, output: receipt },
  'practice.write': { input: { ...study, questions: [practiceQuestion] }, output: receipt },
  'quiz.propose': { input: proposal, output: { assessmentRef: 'ed:7:11', revision, sourceRevision: digest, evidence: ['prompt-only' as const] } },
  'quiz.read': { input: { course: '7', lesson: '11' }, output: { assessmentRef: 'ed:7:11',
    questions: [{ ref: questionRef, supported: true as const, type: 'text' as const, prompt: quizCitation.quote }],
    sources: [{ sourceItemId: questionRef, text: quizCitation.quote, locator: quizCitation.locator }],
    coverage: { complete: true, scope: 'assessment' as const, total: 1, supported: 1, unsupported: 0 } } },
  'quiz.review': { input: { assessmentId: assessment.id, revision, page: filled.page }, output: { status: 'approved' as const, revision } },
  'quiz.prerequisites': { input: { version: 1 as const, binding, repositoryPrivate: true as const, verifiedAt: at }, output: { recorded: 'prerequisites' as const } },
  'policy.record': { input: policy, output: { recorded: 'policy' as const, policyRef: digest,
    courseId: policy.courseId, status: policy.status, cap: policy.cap, recordedAt: at } },
  'grant.record': { input: grant, output: { recorded: 'grant' as const, grantRef: digest,
    courseId: grant.courseId, assessmentId: grant.assessmentId, category: grant.category, level: grant.level, recordedAt: at } },
  'quiz.policy': { input: { version: 1 as const, course: '7', status: 'owner-attested' as const, attestation: 'Synthetic fixture only.', date: '2026-10-12', cap: 4 }, output: { recorded: 'policy' as const } },
  'quiz.grant': { input: { version: 1 as const, binding, level: 4, date: '2026-01-01' }, output: { recorded: 'grant' as const } },
  'audit.list': { input: { limit: 10 }, output: page({ id: revision, runId: revision, command: 'synthetic', phase: 'intent' as const, at, code: 'OK' as const }) },
  'quiz.fill': { input: fillInput, output: { status: 'filled' as const, target: filled } },
  'quiz.submit': { input: { ...filled, confirmationToken: 'synthetic-confirmation' }, output: { status: 'submitted' as const, target: filled } },
} satisfies { [N in CommandName]: { input: CommandInput<N>; output: CommandOutput<N> } };

/** In-memory fixture port; output is cloned so M3 cannot mutate shared example objects. */
export class FakeRepository implements ProtocolRepository {
  readonly outputs = new Map<ReadCommand, unknown>();
  constructor() {
    for (const name of Object.keys(examples) as CommandName[]) {
      if (name.endsWith('.list') || ['sources.get', 'proposals.get', 'changes', 'quiz.read'].includes(name)) {
        this.outputs.set(name as ReadCommand, structuredClone(examples[name].output));
      }
    }
  }
  async read<N extends ReadCommand>(name: N, _input: ParsedCommandInput<N>): Promise<CommandOutput<N>> {
    // These are deterministic contract fixtures, not a production query/filter implementation.
    return structuredClone(this.outputs.get(name)) as CommandOutput<N>;
  }
}
export class FakeServices implements ProtocolServices {
  readonly writes: { name: WriteCommand; input: unknown }[] = [];
  async write<N extends WriteCommand>(name: N, input: ServiceInput<N>): Promise<CommandOutput<N>> {
    this.writes.push({ name, input: structuredClone(input) });
    return structuredClone(examples[name].output) as CommandOutput<N>;
  }
  /** Synthetic stand-in for D's explicit identity map: the fixed Q1 example maps to the fixed canonical target. */
  async recordingTarget(name: 'policy.record' | 'grant.record'): Promise<{ courseId: string; assessmentId?: string }> {
    return name === 'policy.record' ? { courseId: examples['policy.record'].output.courseId }
      : { courseId: examples['grant.record'].output.courseId, assessmentId: examples['grant.record'].output.assessmentId };
  }
}
/** O6 test double. Production expiry/serialization/rechecks belong to H, not this fixture. */
export class FakeConfirmations implements ConfirmationService {
  private readonly tokens = new Map<string, Confirmation>();
  constructor(private readonly now: () => number = Date.now) {}
  async issue(target: FilledTarget, owner: NonNullable<TrustedContext['owner']>): Promise<Confirmation> {
    await owner.assertOwner('quiz.submit');
    const confirmation = { token: randomUUID(), target: structuredClone(target), expiresAt: new Date(this.now() + 60000).toISOString() };
    this.tokens.set(confirmation.token, confirmation);
    return structuredClone(confirmation);
  }
  async consume(token: string, current: FilledTarget): Promise<void> {
    const confirmation = this.tokens.get(token);
    if (!confirmation || this.now() >= Date.parse(confirmation.expiresAt) || JSON.stringify(confirmation.target) !== JSON.stringify(current)) {
      throw new CourseworkError('CONFLICT', 'Synthetic confirmation is stale.');
    }
    this.tokens.delete(token);
  }
}
export function createFakeRegistry() { return createRegistry(); }
export function createFakeContext(options: { owner?: boolean; actions?: boolean } = {}) {
  const events: AuditEvent[] = []; const runEvents: AuditEvent[] = []; const actionCalls: string[] = [];
  const redactor = createRedactor({});
  const clean = (value: unknown): unknown => typeof value === 'string' ? redactor.text(value)
    : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
  const context: TrustedContext & { events: AuditEvent[]; runEvents: AuditEvent[]; actionCalls: string[] } = {
    repository: new FakeRepository(), services: new FakeServices(),
    // Contract fixtures deliberately do not claim production evidence/authorization verification.
    evidence: { check: async () => {} }, authorization: { check: async () => {} },
    privacy: { protect: async (_command, data) => clean(data) },
    audit: { record: async event => { events.push({ ...event }); } },
    runs: { record: async event => { runEvents.push({ ...event }); } },
    confirmations: new FakeConfirmations(), events, runEvents, actionCalls,
    ...(options.owner ? { owner: { assertOwner: async () => {} } } : {}),
    ...(options.actions ? { actions: {
      fill: async () => { actionCalls.push('quiz.fill'); return structuredClone(examples['quiz.fill'].output); },
      submit: async () => { actionCalls.push('quiz.submit'); return structuredClone(examples['quiz.submit'].output); },
    } } : {}),
  };
  return context;
}
