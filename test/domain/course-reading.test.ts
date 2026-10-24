import { expect, it } from 'vitest';
import { AssessmentSchema, CourseSchema, CourseSelectionSchema, RunSchema, SyncJobSchema } from '../../src/domain/schemas.js';

const at = '2026-10-24T01:00:00Z';
const coverage = { courseRef: 'c'.repeat(64), stored: true, submissions: 2, unknownFields: 1,
  platforms: { canvas: 'blocked', ed: 'read' }, policyChanged: false };
const agentRun = { id: 'run-agent', command: 'sync', startedAt: at, endedAt: at, steps: 9, outcome: 'error', turns: 12, syncOutcome: 'PARTIAL', courseCoverage: [coverage] };

it('Agent sync run: turns without a conversation, a sync outcome and count-only course coverage are valid', () => {
  expect(RunSchema.parse(agentRun)).toEqual(agentRun);
  for (const patch of [{ courseRef: 'https://canvas.lms.unimelb.edu.au/courses/1' }, { quote: 'Synthetic quote' }, { unknownFields: -1 },
    { platforms: { canvas: 'maybe', ed: 'read' } }]) {
    expect(RunSchema.safeParse({ ...agentRun, courseCoverage: [{ ...coverage, ...patch }] }).success).toBe(false);
  }
  expect(RunSchema.safeParse({ ...agentRun, syncOutcome: 'DONE' }).success).toBe(false);
  // Turns without a conversation stay refused outside agent sync runs.
  const { syncOutcome: _outcome, courseCoverage: _coverage, ...plain } = agentRun;
  expect(RunSchema.safeParse(plain).success).toBe(false);
  expect(RunSchema.safeParse({ ...agentRun, conversationId: 'conversation' }).success).toBe(false);
});

it('Course and Assessment accept the optional agent-read fields', () => {
  const readState = { name: { state: 'found', via: 'screenshot' }, due: { state: 'unknown', checkedAt: at },
    weight: { state: 'derived' }, aiPolicy: { state: 'found', via: 'ax', quote: 'Synthetic policy', source: 'https://canvas.lms.unimelb.edu.au/courses/1' } };
  const course = { id: 'c', moduleId: 'm', code: 'SYNA10001', name: 'Synthetic', term: '2026:S2', assessmentsComplete: false, aiPolicy: 'prohibited', readState };
  expect(CourseSchema.parse(course)).toEqual({ ...course, sources: [] });
  expect(CourseSchema.safeParse({ ...course, aiPolicy: 'maybe' }).success).toBe(false);
  const assessment = { id: 'a', courseId: 'c', name: 'Synthetic', isFinal: false, status: 'not_started', origin: 'sync',
    group: { key: 'SYNA10001:written', name: 'Written', weight: 15, count: 4 }, retired: true, readState };
  expect(AssessmentSchema.parse(assessment)).toEqual(assessment);
  expect(AssessmentSchema.safeParse({ ...assessment, readState: { weight: { state: 'guessed' } } }).success).toBe(false);
});

it('CourseSelection and SyncJob follow the contract', () => {
  const selection = { key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/1', ed: 'https://edstem.org/au/courses/2' }, offeredAt: at };
  expect(CourseSelectionSchema.parse(selection)).toEqual(selection);
  expect(CourseSelectionSchema.parse({ ...selection, selected: true, decidedAt: at })).toMatchObject({ selected: true });
  expect(CourseSelectionSchema.safeParse({ ...selection, term: '2026 S2' }).success).toBe(false);
  expect(CourseSelectionSchema.safeParse({ ...selection, pages: { canvas: 'https://example.test/courses/1' } }).success).toBe(false);
  const job = { id: 'job', startedAt: at, courses: [selection.key], submissions: { [selection.key]: 2 } };
  expect(SyncJobSchema.parse(job)).toEqual(job);
  expect(SyncJobSchema.parse({ ...job, endedAt: at, outcome: 'NEEDS_SELECTION' })).toMatchObject({ outcome: 'NEEDS_SELECTION' });
  expect(SyncJobSchema.safeParse({ ...job, submissions: { [selection.key]: -1 } }).success).toBe(false);
});
