import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { BRIEF_LIMIT, BRIEF_HEADER, collectBrief, renderBrief, type BriefSection } from '../../src/memory/brief.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { courseEvidence } from '../../src/revision/sources.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { hash } from '../../src/citations/exact.js';

const stores: SqliteRepository[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const now = new Date('2026-10-26T00:00:00.000Z');
const PAGE_TEXT = 'Synthetic lecture sentence that must never reach the brief.';
function store() {
  const s = new SqliteRepository(':memory:'); stores.push(s);
  s.saveModule({ id: 'm', name: 'Synthetic', glyph: 'S', auto: false });
  for (const [id, code] of [['c-1', 'SYNA10001'], ['c-2', 'SYNB20002'], ['c-3', 'SYNC30003']] as const) {
    s.saveCourse({ id, moduleId: 'm', code, name: `Synthetic ${code}`, term: '2026:S2', assessmentsComplete: true, aiPolicy: 'allowed' });
    s.saveSourceItem({ id: `src-${id}`, externalId: `src-${id}`, courseId: id, platform: 'canvas', kind: 'material', title: 'Lecture', text: PAGE_TEXT,
      contentHash: hash(PAGE_TEXT), fetchedAt: '2026-10-01T00:00:00Z' });
  }
  return s;
}
async function practice(s: SqliteRepository, courseId: string, wrong: number, total = 4, week?: number) {
  const snapshot = await courseEvidence(s, new TrustedStoreEvidence(s), courseId);
  const citation = { sourceItemId: `src-${courseId}`, quote: 'Synthetic', locator: 'text' };
  const revision = randomUUID();
  const questions = Array.from({ length: total }, (_, index) => ({ id: `${courseId}-q${week ?? 0}-${index}`, prompt: `Question ${index}`, kind: 'open' as const,
    answer: 'Synthetic', explanation: [{ text: 'Synthetic.', citations: [citation] }] }));
  s.publishStudyRecord('practice.write', `${courseId}-p${week ?? 0}`, undefined, { id: `${courseId}-p${week ?? 0}`, revision, courseId, ...(week ? { week } : {}),
    sourceRevision: snapshot.sourceRevision, questions, citations: [{ ...citation, offset: 0, end: 9, sourceHash: hash(PAGE_TEXT) }], limitations: [] });
  questions.forEach((question, index) => s.appendPracticeAttempt({ questionId: question.id, revision, outcome: index < wrong ? 'incorrect' : 'correct', at: '2026-10-25T10:00:00.000Z' }));
}
async function note(s: SqliteRepository, courseId: string, week?: number) {
  const snapshot = await courseEvidence(s, new TrustedStoreEvidence(s), courseId);
  const citation = { sourceItemId: `src-${courseId}`, quote: 'Synthetic', locator: 'text' };
  const id = randomUUID();
  s.publishStudyRecord('revision.write', id, undefined, { id, revision: randomUUID(), courseId, ...(week ? { week } : {}), sourceRevision: snapshot.sourceRevision,
    claims: [{ text: PAGE_TEXT, citations: [citation] }], citations: [{ ...citation, offset: 0, end: 9, sourceHash: hash(PAGE_TEXT) }], limitations: [] });
}
const select = (s: SqliteRepository, codes: string[]) => s.saveCourseSelections(['SYNA10001', 'SYNB20002', 'SYNC30003'].map(code => ({
  key: `${code}:2026:S2`, code, term: '2026:S2', pages: {}, offeredAt: '2026-10-01T00:00:00.000Z', selected: codes.includes(code) })));

it('New conversation for a course: both items due this week with dates and the three wrong answers, marked as background', async () => {
  const s = store();
  s.saveAssessment({ id: 'a-1', courseId: 'c-1', name: 'Assignment 1', kind: 'assignment', isFinal: false, status: 'not_started', due: '2026-10-28T13:00:00.000Z' });
  s.saveAssessment({ id: 'a-2', courseId: 'c-1', name: 'Quiz 2', kind: 'quiz', isFinal: false, status: 'in_progress', due: '2026-10-30T13:00:00.000Z' });
  s.saveAssessment({ id: 'a-3', courseId: 'c-1', name: 'Far away essay', kind: 'assignment', isFinal: false, status: 'not_started', due: '2026-12-30T13:00:00.000Z' });
  s.saveAssessment({ id: 'a-4', courseId: 'c-1', name: 'Done quiz', kind: 'quiz', isFinal: false, status: 'graded', score: 85, due: '2026-10-20T13:00:00.000Z' });
  s.saveAssessment({ id: 'a-5', courseId: 'c-2', name: 'Other course item', kind: 'quiz', isFinal: false, status: 'not_started', due: '2026-10-28T13:00:00.000Z' });
  await practice(s, 'c-1', 3);
  await note(s, 'c-1', 3); await note(s, 'c-1', 3); await note(s, 'c-1');
  s.saveMemory({ id: 'mem-1', courseId: 'c-1', kind: 'weakness', text: 'Mixes up eigenvalues and eigenvectors', origin: 'agent', createdAt: '2026-10-24T00:00:00.000Z' });
  s.saveMemory({ id: 'mem-2', kind: 'preference', text: 'Explain with an example first', origin: 'owner', createdAt: '2026-10-25T00:00:00.000Z' });
  s.saveMemory({ id: 'mem-3', courseId: 'c-2', kind: 'habit', text: 'Other course habit', origin: 'owner', createdAt: '2026-10-25T00:00:00.000Z' });
  s.saveMemory({ id: 'mem-4', kind: 'habit', text: 'Deleted memory text', origin: 'owner', createdAt: '2026-10-25T00:00:00.000Z', deletedAt: '2026-10-25T01:00:00.000Z' });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief.startsWith(BRIEF_HEADER)).toBe(true);
  expect(brief).toMatch(/not instructions/);
  expect(brief).toContain('Assignment 1'); expect(brief).toContain('2026-10-28T13:00:00.000Z');
  expect(brief).toContain('Quiz 2'); expect(brief).toContain('2026-10-30T13:00:00.000Z');
  expect(brief).not.toContain('Far away essay'); expect(brief).not.toContain('Other course item');
  expect(brief).toMatch(/3 wrong/);
  expect(brief).toMatch(/Done quiz[^\n]*85%/);
  expect(brief).toMatch(/week 3: 2 notes/); expect(brief).toMatch(/no week: 1 note/);
  expect(brief).toMatch(/AI policy allowed; default level L0/);
  // Course-specific memories first, then general; other courses and deleted memories are left out.
  expect(brief.indexOf('Mixes up eigenvalues')).toBeLessThan(brief.indexOf('Explain with an example first'));
  expect(brief).not.toContain('Other course habit'); expect(brief).not.toContain('Deleted memory text');
  // Only titles, dates, numbers and memory texts: never page text or quotes.
  expect(brief).not.toContain(PAGE_TEXT); expect(brief).not.toContain('Question 0');
  expect(brief.length).toBeLessThanOrEqual(BRIEF_LIMIT);
});

it('unknown fields name the item, the fields and the check time', () => {
  const s = store();
  s.saveAssessment({ id: 'a-1', courseId: 'c-1', name: 'Project', kind: 'assignment', isFinal: false, status: 'not_started',
    readState: { weight: { state: 'unknown', checkedAt: '2026-10-20T00:00:00.000Z' }, due: { state: 'found' } } });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief).toMatch(/Project[^\n]*weight[^\n]*2026-10-20/);
});

it('All selected courses: a conversation without a course covers both selected courses and no other', async () => {
  const s = store(); select(s, ['SYNA10001', 'SYNB20002']);
  s.saveAssessment({ id: 'a-1', courseId: 'c-1', name: 'Alpha item', isFinal: false, status: 'not_started', due: '2026-10-28T00:00:00.000Z' });
  s.saveAssessment({ id: 'a-2', courseId: 'c-2', name: 'Beta item', isFinal: false, status: 'not_started', due: '2026-10-29T00:00:00.000Z' });
  s.saveAssessment({ id: 'a-3', courseId: 'c-3', name: 'Gamma item', isFinal: false, status: 'not_started', due: '2026-10-29T00:00:00.000Z' });
  s.saveMemory({ id: 'mem-3', courseId: 'c-3', kind: 'habit', text: 'Unselected course habit', origin: 'owner', createdAt: '2026-10-25T00:00:00.000Z' });
  const brief = collectBrief(s, {}, { now });
  expect(brief).toContain('Alpha item'); expect(brief).toContain('Beta item'); expect(brief).not.toContain('Gamma item');
  expect(brief).toContain('SYNA10001'); expect(brief).toContain('SYNB20002'); expect(brief).not.toContain('SYNC30003');
  expect(brief).not.toContain('Unselected course habit');
});

const section = (title: string, items: [string, number][], drop: BriefSection['drop'] = 'oldest'): BriefSection =>
  ({ title, drop, items: items.map(([line, rank]) => ({ line, rank })) });
it('Bounded brief: at most 8,000 characters, memories dropped before practice, least relevant items first in the cut section', () => {
  const big = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => [`${prefix} ${i} ${'x'.repeat(80)}`, i] as [string, number]);
  const sections = [
    section('AI policy and default level', [['SYNA10001: AI policy allowed', 0]]),
    // Due work: the latest due date is least relevant (rank is the negated due time).
    section('Open work due in the next 14 days', [['Due soon', -1], ['Due later', -5]], 'latest'),
    section('Practice', big('practice', 100)),
    section('Memories', big('memory', 40)),
  ];
  const brief = renderBrief(sections);
  expect(brief.length).toBeLessThanOrEqual(BRIEF_LIMIT);
  expect(brief).not.toContain('## Memories');
  expect(brief).toContain('Due later'); expect(brief).toContain('Due soon');
  // Practice crosses the bound: the oldest (lowest rank) items go first, the newest stay, in listing order.
  expect(brief).toContain('practice 99'); expect(brief).not.toContain('practice 0 ');
  const kept = [...brief.matchAll(/practice (\d+) /g)].map(match => Number(match[1]));
  expect(kept).toEqual([...kept].sort((a, b) => a - b)); expect(kept[0]).toBeGreaterThan(0);

  const due = renderBrief([section('Open work due in the next 14 days', Array.from({ length: 120 }, (_, i) => [`due item ${i} ${'y'.repeat(80)}`, -i] as [string, number]), 'latest')]);
  expect(due.length).toBeLessThanOrEqual(BRIEF_LIMIT);
  expect(due).toContain('due item 0 '); expect(due).not.toContain('due item 119 ');
  expect(renderBrief([section('Practice', [['short', 1]])]).length).toBeLessThan(BRIEF_LIMIT);
});

it('bounded through the store: more than 8,000 characters of facts still yields a bounded brief', async () => {
  const s = store();
  for (let i = 0; i < 120; i++) s.saveAssessment({ id: `a-${i}`, courseId: 'c-1', name: `Synthetic assessment with a long name number ${i}`, isFinal: false,
    status: 'not_started', due: new Date(now.getTime() + (i + 1) * 3_600_000).toISOString() });
  for (let i = 0; i < 20; i++) s.saveMemory({ id: `m-${i}`, courseId: 'c-1', kind: 'other', text: `Memory ${i} ${'z'.repeat(400)}`, origin: 'owner', createdAt: '2026-10-24T00:00:00.000Z' });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief.length).toBeLessThanOrEqual(BRIEF_LIMIT);
  expect(brief).toContain('number 0 '); expect(brief).not.toContain('## Memories');
});

it('uses the effective policy and annotated due date, and does not call a resolved field unknown', () => {
  const s = store();
  s.appendCourseAutonomy({ courseId: 'c-1', defaultLevel: 2, at: now.toISOString(), confirmBeforeSubmit: true });
  s.appendAnnotation({ id: 'policy', entity: 'course', entityId: 'c-1', field: 'aiPolicy', value: 'prohibited', origin: 'owner', citations: [], at: now.toISOString() });
  s.saveAssessment({ id: 'a', courseId: 'c-1', name: 'Annotated task', isFinal: false, status: 'not_started',
    readState: { due: { state: 'unknown', checkedAt: now.toISOString() } } });
  s.appendAnnotation({ id: 'due', entity: 'assessment', entityId: 'a', field: 'due', value: '2026-10-28T00:00:00.000Z', origin: 'owner', citations: [], at: now.toISOString() });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief).toContain('AI policy prohibited; default level L0');
  expect(brief).toContain('Annotated task — due 2026-10-28');
  expect(brief).not.toContain('## Required fields still unknown');
});

it('selects at most twenty newest live memories, course-specific before general', () => {
  const s = store();
  for (let i = 1; i <= 23; i++) s.saveMemory({ id: `mem-${i}`, kind: 'habit', origin: 'agent', text: `Observation ${i}.`,
    createdAt: new Date(now.getTime() - i * 86400000).toISOString() });
  s.saveMemory({ id: 'course-memory', courseId: 'c-1', kind: 'other', origin: 'owner', text: 'Course first.', createdAt: '2020-01-01T00:00:00.000Z' });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief.indexOf('Course first.')).toBeLessThan(brief.indexOf('Observation 1.'));
  expect(brief).toContain('Observation 19.'); expect(brief).not.toContain('Observation 20.');
});

it('includes unfinished course tasks with inherited effective due dates, excluding completed or unrelated tasks', () => {
  const s = store();
  s.saveAssessment({ id: 'a', courseId: 'c-1', name: 'Project', isFinal: false, status: 'in_progress', due: '2026-10-28T00:00:00.000Z' });
  const task = { id: 't', moduleId: 'm', assessmentId: 'a', title: 'Project outline', source: 'coursework' as const, done: false,
    steps: [{ title: 'Outline', estimateMinutes: 10, done: false, citations: [{ sourceItemId: 'src-c-1', quote: 'Synthetic', locator: 'text' }] }] };
  s.saveTask(task);
  s.saveTask({ ...task, id: 'done', title: 'Finished task', done: true });
  s.saveTask({ ...task, id: 'done-steps', title: 'Finished steps', steps: task.steps.map(step => ({ ...step, done: true })) });
  s.saveTask({ ...task, id: 'other', assessmentId: undefined, courseId: 'c-2', title: 'Other course task', due: '2026-10-29T00:00:00.000Z' });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief).toContain('Project outline — due 2026-10-28T00:00:00.000Z');
  expect(brief).not.toMatch(/Finished task|Finished steps|Other course task/);
});

it('Bounded brief retains whole titles and drops entire oversized items rather than truncating titles', () => {
  const s = store();
  s.saveAssessment({ id: 'a', courseId: 'c-1', name: `Whole title ${'x'.repeat(220)} END`, isFinal: false, status: 'in_progress', due: '2026-10-28T00:00:00.000Z' });
  expect(collectBrief(s, { courseId: 'c-1' }, { now })).toContain(`Whole title ${'x'.repeat(220)} END`);
});

it('omits course unknown fields resolved by owner annotations', () => {
  const s = store();
  s.saveCourse({ ...s.loadCourse('c-1')!, readState: { aiPolicy: { state: 'unknown', checkedAt: now.toISOString() }, assessmentsComplete: { state: 'unknown', checkedAt: now.toISOString() } } });
  s.appendAnnotation({ id: 'policy', entity: 'course', entityId: 'c-1', field: 'aiPolicy', value: 'prohibited', origin: 'owner', citations: [], at: now.toISOString() });
  s.appendAnnotation({ id: 'complete', entity: 'course', entityId: 'c-1', field: 'assessmentsComplete', value: true, origin: 'owner', citations: [], at: now.toISOString() });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief).not.toContain('## Required fields still unknown');
});

it('All selected courses retains the effective policy even when a course exceeds the autonomy read page bound', () => {
  const s = store(); select(s, ['SYNA10001', 'SYNB20002']);
  for (let i = 0; i < 501; i++) s.saveAssessment({ id: `large-${i}`, courseId: 'c-1', name: `Item ${i}`, isFinal: false, status: 'graded' });
  s.appendAnnotation({ id: 'policy', entity: 'course', entityId: 'c-1', field: 'aiPolicy', value: 'prohibited', origin: 'owner', citations: [], at: now.toISOString() });
  expect(collectBrief(s, {}, { now })).toContain('AI policy prohibited; default level L0');
});

it('uses the latest current-revision attempts by instant, including different UTC offsets', async () => {
  const s = store(); await practice(s, 'c-1', 3);
  const record = s.listStudyRecords('practice.write')[0]!;
  s.appendPracticeAttempt({ questionId: 'c-1-q0-0', revision: record.revision, outcome: 'correct', at: '2026-10-26T00:30:00+11:00' });
  s.appendPracticeAttempt({ questionId: 'c-1-q0-1', revision: record.revision, outcome: 'incorrect', at: '2026-10-25T20:00:00Z' });
  s.appendPracticeAttempt({ questionId: 'c-1-q0-2', revision: randomUUID(), outcome: 'correct', at: '2026-10-26T00:00:00Z' });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now });
  expect(brief).toContain('2 wrong (last attempt 2026-10-25T20:00:00Z)');
});

it('retains personal and credential-shaped text while applying the length bound', () => {
  const s = store();
  const email = 'someone@student.example.edu';
  s.saveCourse({ ...s.loadCourse('c-1')!, name: `Course ${email}` });
  s.saveAssessment({ id: 'private', courseId: 'c-1', name: `Assessment ${email}`, isFinal: false, status: 'not_started',
    due: '2026-10-28T00:00:00.000Z', score: 70, readState: { weight: { state: 'unknown' } } });
  s.saveTask({ id: 'manual', moduleId: 'm', courseId: 'c-1', title: `Manual ${email}`, source: 'manual', done: false,
    due: '2026-10-28T00:00:00.000Z', steps: [{ title: 'Study', estimateMinutes: 10, done: false, citations: [] }] });
  s.saveMemory({ id: 'legacy', kind: 'other', origin: 'owner', text: `Legacy Jane Example ${email}`, createdAt: now.toISOString() });
  s.saveAssessment({ id: 'unsafe', courseId: 'c-1', name: 'Unsafe api_key=synthetic', isFinal: false, status: 'not_started', due: '2026-10-28T00:00:00.000Z' });
  s.saveMemory({ id: 'unsafe-memory', kind: 'other', origin: 'owner', text: 'Unsafe password=synthetic', createdAt: now.toISOString() });
  const brief = collectBrief(s, { courseId: 'c-1' }, { now, project: assessment => assessment });
  expect(brief).toContain(email); expect(brief).toContain('Jane Example'); expect(brief).toContain('Unsafe');
  for (const prefix of ['Course', 'Assessment', 'Manual']) expect(brief).toContain(`${prefix} ${email}`);
  expect(brief).toContain(`Legacy Jane Example ${email}`);
  expect(brief).toContain('70%'); expect(brief).toContain('weight');
  const sections = [section('Facts', [[`Contact ${email.repeat(300)}`, 1], ['Unsafe api_key=synthetic', 2], ['Safe fact', 3]])];
  const rendered = renderBrief(sections, BRIEF_HEADER.length + 100);
  expect(rendered).not.toContain('Contact'); expect(rendered).toContain('Safe fact');
  expect(rendered).toContain('Unsafe api_key=synthetic'); expect(rendered.length).toBeLessThanOrEqual(BRIEF_HEADER.length + 100);
});
