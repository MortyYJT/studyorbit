/** Synthetic-only contract fixtures and in-memory ports for M3. Never mount as production services. */
import { randomUUID } from 'node:crypto';
import { contracts, type CommandName, type CommandInput, type CommandOutput, type ParsedCommandInput } from './contracts.js';
import { createRegistry } from './registry.js';
import type { TrustedContext, AuditEvent, ReadCommand, WriteCommand, ProtocolRepository, ProtocolServices, ServiceInput } from './context.js';
import { CourseworkError } from './errors.js';

const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const digest = 'a'.repeat(64);
const at = '2026-01-01T00:00:00Z';
const binding = { assessmentId: 'synthetic-assessment', course: '7', lesson: '11', category: 'assignment' as const };
const citation = { sourceItemId: 'synthetic-source', quote: 'Read the synthetic guide.', locator: 'page:1' };
const verified = { ...citation, offset: 0, end: 25, sourceHash: digest, page: 1 };
const source = { sourceItemId: citation.sourceItemId, courseId: 'synthetic-course', text: citation.quote,
  sourceHash: digest, locator: citation.locator, page: 1, provenance: 'manual' as const };
const course = { id: 'synthetic-course', moduleId: 'synthetic-module', code: 'SYN10001', name: 'Synthetic course', term: 'Synthetic term', assessmentsComplete: false };
const assessment = { id: binding.assessmentId, courseId: course.id, name: 'Synthetic assessment', kind: 'assignment' as const,
  weight: 10, isFinal: false, status: 'not_started' as const,
  savedFiles: [{ id: 'synthetic-saved-file', name: 'synthetic-guide.html', current: true, savedAt: at, updated: false }] };
const conflict = { id: 'synthetic-conflict', courseId: course.id, target: { componentKey: 'SYN10001:assignments' },
  field: 'weight' as const, skeletonValue: 30, canvasValue: 40, state: 'open' as const, checkedAt: at, componentName: 'Assignments' };
const update = { savedFileId: 'synthetic-saved-file', courseId: course.id, assessmentId: assessment.id,
  assessmentName: assessment.name, name: 'synthetic-guide.html', savedAt: at };
const task = { id: 'synthetic-task', moduleId: course.moduleId, courseId: course.id, assessmentId: assessment.id,
  title: 'Read instructions', source: 'coursework' as const, steps: [{ title: 'Read the synthetic guide.', estimateMinutes: 15, done: false, citations: [citation] }] };
const claim = { text: 'Read the synthetic guide.', citations: [citation] };
const study = { courseId: course.id, week: 1, sourceRevision: digest };
const receipt = { id: 'synthetic-record', revision, sourceRevision: digest, citations: [verified], limitations: ['Citation membership does not establish correctness.'] };
const note = { ...receipt, ...study, claims: [claim] };
const practiceQuestion = { id: 'synthetic-question', prompt: 'What should you read?', kind: 'open' as const,
  answer: 'The synthetic guide.', explanation: [claim] };
const practice = { ...receipt, ...study, questions: [practiceQuestion] };
const policy = { version: 1 as const, courseId: course.id, status: 'owner-attested' as const,
  attestation: 'Synthetic fixture only.', date: '2026-01-01', cap: 4 as const };
const grant = { version: 1 as const, courseId: course.id, assessmentId: assessment.id, category: 'assignment' as const, level: 4 as const, date: '2026-01-01' };
function page<T>(item: T) { return { items: [item], evidence: [source], coverage: { complete: false, gaps: [{ code: 'INCOMPLETE' as const }] } }; }
export const examples = {
  'source.record': { input: { courseId: course.id, url: 'https://canvas.lms.unimelb.edu.au/courses/1/pages/synthetic', title: 'Synthetic page', text: 'Read the synthetic guide.' },
    output: { sourceItemId: source.sourceItemId, empty: false, locator: 'text', sourceHash: digest, copiedBy: 'agent' as const, sourceRevision: digest } },
  'revision.read': { input: { courseId: course.id }, output: { sourceRevision: digest, examScope: null } },
  'practice.stats': { input: { courseId: course.id }, output: { questions: 1, attempted: 0, correct: 0, incorrect: 0, wrongQuestions: [] } },
  'practice.attempt.record': { input: { questionId: practiceQuestion.id, revision, outcome: 'incorrect' as const, at }, output: { recorded: true as const } },
  'courses.list': { input: { limit: 10 }, output: page(course) },
  'assessments.list': { input: { courseId: course.id, limit: 10 }, output: page(assessment) },
  'conflicts.list': { input: { courseId: course.id, state: 'open' as const, limit: 10 }, output: page(conflict) },
  'updates.list': { input: { limit: 10 }, output: page(update) },
  'file.open': { input: { savedFileId: 'synthetic-saved-file' }, output: { opened: true as const, openedAt: at } },
  'tasks.list': { input: { courseId: course.id, limit: 10 }, output: page(task) },
  'sources.get': { input: { sourceItemId: source.sourceItemId }, output: source },
  'assessment.files': { input: { assessmentId: assessment.id }, output: { files: [] } },
  'materials.list': { input: { courseId: course.id, limit: 10 }, output: page(source) },
  'runs.list': { input: { limit: 10 }, output: page({ id: revision, command: 'synthetic', startedAt: at, endedAt: at, steps: 0, outcome: 'ok' as const }) },
  'revision.list': { input: { courseId: study.courseId, week: study.week, limit: 10 }, output: page(note) },
  'practice.list': { input: { courseId: study.courseId, week: study.week, limit: 10 }, output: page(practice) },
  'breakdown.write': { input: { assessmentId: assessment.id, sourceRevision: digest, task }, output: receipt },
  'revision.write': { input: { ...study, claims: [claim] }, output: receipt },
  'practice.write': { input: { ...study, questions: [practiceQuestion] }, output: receipt },
  'policy.record': { input: policy, output: { recorded: 'policy' as const, policyRef: digest,
    courseId: policy.courseId, status: policy.status, cap: policy.cap, recordedAt: at } },
  'grant.record': { input: grant, output: { recorded: 'grant' as const, grantRef: digest,
    courseId: grant.courseId, assessmentId: grant.assessmentId, category: grant.category, level: grant.level, recordedAt: at } },
  'audit.list': { input: { limit: 10 }, output: page({ id: revision, runId: revision, command: 'synthetic', phase: 'intent' as const, at, code: 'OK' as const }) },
} satisfies { [N in CommandName]: { input: CommandInput<N>; output: CommandOutput<N> } };

/** In-memory fixture port; output is cloned so M3 cannot mutate shared example objects. */
export class FakeRepository implements ProtocolRepository {
  readonly outputs = new Map<ReadCommand, unknown>();
  constructor() {
    for (const name of Object.keys(examples) as CommandName[]) {
      if (name.endsWith('.list') || ['sources.get', 'revision.read', 'practice.stats'].includes(name)) {
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
export function createFakeRegistry() {
  return createRegistry({ savedFiles: { open: async () => structuredClone(examples['file.open'].output) } });
}
export function createFakeContext(options: { owner?: boolean } = {}) {
  const events: AuditEvent[] = []; const runEvents: AuditEvent[] = []; const actionCalls: string[] = [];
  const context: TrustedContext & { events: AuditEvent[]; runEvents: AuditEvent[]; actionCalls: string[] } = {
    repository: new FakeRepository(), services: new FakeServices(),
    // Contract fixtures deliberately do not claim production evidence/authorization verification.
    evidence: { check: async () => {} }, authorization: { check: async () => {} },
    audit: { record: async event => { events.push({ ...event }); } },
    events, runEvents, actionCalls,
    runs: { record: async event => { runEvents.push({ ...event }); } },
    ...(options.owner ? { owner: { assertOwner: async () => {} } } : {}),
  };
  return context;
}
