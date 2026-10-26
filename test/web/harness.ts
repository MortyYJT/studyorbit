/**
 * Developer harness: serve the owner UI against a synthetic, temporary data directory.
 *
 * Run from the repository root:
 *
 *   npm run build && node test/web/harness.ts
 *
 * Node 24 strips TypeScript types natively, but it neither rewrites the `.js` import specifiers used in
 * `src/` nor supports the parameter properties used there. This file therefore only imports types from
 * `src/` (erased at run time) and loads the compiled modules from `dist/` with dynamic imports, which is
 * why the build has to run first (it also produces `dist/ui`). Keep this file free of syntax that needs
 * transformation (enums, parameter properties, namespaces) so plain type stripping keeps working.
 *
 * Everything seeded here is invented. Nothing reads or writes the real data directory, no real browser is
 * attached, and sync runs are refused (the status shows a seeded agent sync job). Stop with Ctrl-C; the temporary directory is removed on exit.
 * The printed URL carries the owner session in its fragment, so treat it as a local secret.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun } from '../../src/agent/adapter.js';
import type { Assessment, Course, Module, SavedFile, SourceItem, Run, SyncConflict } from '../../src/domain/schemas.js';
import type { OwnerInteraction } from '../../src/protocol/context.js';

type Production = typeof import('../../src/protocol/production.js');
type HttpHost = typeof import('../../src/protocol/http-host.js');
type Http = typeof import('../../src/protocol/http.js');
type Registry = typeof import('../../src/protocol/registry.js');
type Sqlite = typeof import('../../src/store/sqlite.js');
type DataDir = typeof import('../../src/config/data-dir.js');
type Errors = typeof import('../../src/protocol/errors.js');
type AgentJob = typeof import('../../src/sync/agent-job.js');
type Citations = typeof import('../../src/citations/exact.js');

const root = resolve(import.meta.dirname, '../..');
const dist = (path: string) => pathToFileURL(join(root, 'dist', path)).href;

// The data directory must be private and fresh before any compiled module resolves it.
const home = mkdtempSync(join(realpathSync(tmpdir()), 'coursework-ui-harness-'));
process.env.COURSEWORK_HOME = home;
// Saved files stay inside this temporary folder; `file.open` never launches the host application here.
const filesRoot = join(home, 'files');
// Also covers a failed seeding step, which ends the process through the rejected top-level await.
process.once('exit', () => rmSync(home, { recursive: true, force: true }));

const { createProductionProtocol } = await import(dist('protocol/production.js')) as Production;
const { startOwnerUI } = await import(dist('protocol/http-host.js')) as HttpHost;
const { httpCommandContext } = await import(dist('protocol/http.js')) as Http;
const { dispatch } = await import(dist('protocol/registry.js')) as Registry;
const { SqliteRepository } = await import(dist('store/sqlite.js')) as Sqlite;
const { databasePath } = await import(dist('config/data-dir.js')) as DataDir;
const { CourseworkError } = await import(dist('protocol/errors.js')) as Errors;
const { AgentSync } = await import(dist('sync/agent-job.js')) as AgentJob;
const { hash } = await import(dist('citations/exact.js')) as Citations;

/** Scripted chat replies: streamed text, an allowed and a denied tool step, then a costed result. */
class ScriptedAdapter implements AgentAdapter {
  readonly id = 'synthetic';
  start(_input: AgentInput): AgentRun {
    const events: AgentEvent[] = [
      { type: 'text', text: 'Reading the synthetic assignment brief. ' },
      { type: 'tool_step', tool: 'sources.get', outcome: 'ok', input: { sourceItemId: 'syn-src-a-outline' } },
      { type: 'text', text: 'Assignment 2 is worth 25% of the final mark. ' },
      { type: 'tool_step', tool: 'autonomy.check', outcome: 'ok', input: { assessmentId: 'syn-b-essay', action: 'fill' } },
      { type: 'text', text: 'I cannot fill the essay: that course prohibits AI assistance.' },
      { type: 'result', turns: 3, costUsd: 0.0123, sessionRef: 'synthetic-session' },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) { await new Promise(done => setTimeout(done, 150)); yield event; }
      },
      interrupt() {},
    };
  }
}

// Dates are relative to today in Melbourne: graded work earlier in this week and before it, open work over the next days,
// so both a calendar week and the planner's horizon starting today have content whenever the harness runs.
const timeZone = 'Australia/Melbourne';
const zonedDate = (instant: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
};
const today = zonedDate(new Date());
const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
// Keep UTC times within 00:00Z-12:59Z (12:59Z is 23:59 AEDT or 22:59 AEST) so the Melbourne date equals the UTC date.
const due = (dayOffset: number, utcTime = '12:59:00Z') => `${addDays(monday, dayOffset)}T${utcTime}`;
const soon = (dayOffset: number, utcTime = '12:59:00Z') => `${addDays(today, dayOffset)}T${utcTime}`;
const now = () => new Date().toISOString();
const term = `${today.slice(0, 4)}:S${Number(today.slice(5, 7)) >= 7 ? 2 : 1}`;

const store = new SqliteRepository(databasePath());
// Status reads the seeded sync job from the store; running a job would need the real agent and the owner's sign-in.
const agentSync = new AgentSync({ store, adapter: () => { throw new CourseworkError('SOURCE_UNAVAILABLE', 'No agent in the synthetic harness.'); }, tools: () => [] });
const host = createProductionProtocol({
  store,
  agentAdapter: new ScriptedAdapter(),
  courseFolder: { root: filesRoot },
  fileOpener: async () => {},
  // Status reads the seeded runs; a real sync would need Codex and the owner's sign-in in their Edge.
  sync: { status: () => agentSync.status(), run: async () => { throw new CourseworkError('SOURCE_UNAVAILABLE', 'Sync is disabled in the synthetic harness.'); } },
});
const owner: OwnerInteraction = { assertOwner: async () => {} };
async function call(name: string, input: unknown): Promise<Record<string, unknown>> {
  const envelope = await dispatch(host.registry, name, input, httpCommandContext(host.context, name, true, () => false));
  if (!envelope.ok) throw new Error(`Seeding ${name} failed: ${envelope.error.code} ${envelope.error.message}`);
  return envelope.data as Record<string, unknown>;
}
const sourceRevision = async (courseId: string) => (await call('revision.read', { courseId })).sourceRevision as string;

// ---- Entities -------------------------------------------------------------------------------------------
const modules: Module[] = [
  { id: 'syn-module-a', name: 'Synthetic Systems', glyph: 'cpu', auto: true },
  { id: 'syn-module-b', name: 'Synthetic Ethics Seminar', glyph: 'book', auto: true },
  { id: 'syn-module-personal', name: 'Synthetic personal', glyph: 'star', auto: false },
];
// Course codes follow the normalized four-letter, five-digit format that sync commands accept.
const courses: Course[] = [
  { id: 'syn-course-a', moduleId: 'syn-module-a', code: 'SYNA10001', name: 'Synthetic Systems', term,
    assessmentsComplete: true, sources: [{ platform: 'canvas', externalId: '900001' }, { platform: 'ed', externalId: '800001' }] },
  // The agent-read AI policy with its quote, as a course document stores it (#180).
  { id: 'syn-course-b', moduleId: 'syn-module-b', code: 'SYNB20002', name: 'Synthetic Ethics Seminar', term,
    assessmentsComplete: false, sources: [{ platform: 'canvas', externalId: '900002' }], aiPolicy: 'prohibited',
    readState: { aiPolicy: { state: 'found', via: 'ax', quote: 'Generative AI tools are not permitted for any assessment in this subject.',
      source: 'https://canvas.lms.unimelb.edu.au/courses/900002/assignments/syllabus' } } },
];
const assessment = (value: Omit<Assessment, 'origin' | 'isFinal'> & { isFinal?: boolean }): Assessment => ({ origin: 'sync', isFinal: false, ...value });
// Course A as course.import stores it: grading components as group tags, per-field read states, an even split (#171)
// and a remainder row for the unpublished share. Item rows carry a `status` read state; component and remainder rows do not.
const found = { state: 'found' as const, via: 'ax' as const, checkedAt: new Date(Date.now() - 3600_000).toISOString() };
const derived = { state: 'derived' as const };
const itemRead = (extra: Assessment['readState'] = {}) => ({ name: found, status: found, due: found, weight: found, kind: found, ...extra });
const quizzes = { key: 'syna10001-quizzes', name: 'Quizzes', weight: 10, count: 2 };
const assignments = { key: 'syna10001-assignments', name: 'Assignments', weight: 45, count: 2 };
const written = { key: 'syna10001-written-assignments', name: 'Written assignments', weight: 15, count: 4 };
const examGroup = { key: 'syna10001-final-exam', name: 'Final exam', weight: 30, count: 1 };
const assessments: Assessment[] = [
  // Graded but its weight stayed unknown after retries, so the Quizzes earned share is unknown (as in the ring).
  assessment({ id: 'syn-a-quiz-1', courseId: 'syn-course-a', name: 'Synthetic Quiz 1', kind: 'quiz', score: 80, due: due(-14), status: 'graded', group: { ...quizzes, role: 'item' },
    readState: itemRead({ weight: { state: 'unknown', via: 'screenshot', checkedAt: found.checkedAt } }) }),
  // Weight unknown after retries; an agent annotation below proposes 5% with a citation.
  // Its own AI policy prohibits AI while the course allows it, so its level stays locked at L0 (#197, 9.3).
  assessment({ id: 'syn-a-quiz-2', courseId: 'syn-course-a', name: 'Synthetic Quiz 2', kind: 'quiz', due: soon(1), status: 'not_started', group: { ...quizzes, role: 'item' },
    unlockAt: soon(-1, '00:00:00Z'), aiPolicy: 'prohibited',
    readState: itemRead({ weight: { state: 'unknown', via: 'screenshot', checkedAt: found.checkedAt },
      aiPolicy: { state: 'found', via: 'ax', checkedAt: found.checkedAt, quote: 'Generative AI is not permitted for this quiz.' } }) }),
  assessment({ id: 'syn-a-assign-1', courseId: 'syn-course-a', name: 'Synthetic Assignment 1', kind: 'assignment', weight: 20, score: 72, due: due(-7), status: 'graded', group: { ...assignments, role: 'item' }, readState: itemRead() }),
  // Unlock time for the drawer, and a weight read through the Canvas API capture so its marker says "from Canvas API".
  assessment({ id: 'syn-a-assign-2', courseId: 'syn-course-a', name: 'Synthetic Assignment 2', kind: 'assignment', weight: 25, due: soon(3), status: 'in_progress',
    group: { ...assignments, role: 'item' }, unlockAt: soon(-2, '22:00:00Z'),
    readState: itemRead({ weight: { state: 'found', via: 'api', source: 'https://canvas.lms.unimelb.edu.au/courses/900001/assignments/2' } }) }),
  // Scenario "Component group": 15% over four items, two published and graded (80% and 100%), each an even split of 3.75.
  assessment({ id: 'syn-a-written-1', courseId: 'syn-course-a', name: 'Synthetic Written Task 1', kind: 'assignment', weight: 3.75, score: 80, due: due(-10), status: 'graded',
    group: { ...written, role: 'item' }, readState: itemRead({ weight: derived }) }),
  // Scenario "Derived and unknown labels": due date unknown after retries, with its check time.
  assessment({ id: 'syn-a-written-2', courseId: 'syn-course-a', name: 'Synthetic Written Task 2', kind: 'assignment', weight: 3.75, score: 100, status: 'graded',
    group: { ...written, role: 'item' }, readState: itemRead({ weight: derived, due: { state: 'unknown', via: 'screenshot', checkedAt: found.checkedAt } }) }),
  assessment({ id: 'syn-a-written-rest', courseId: 'syn-course-a', name: 'Written assignments', kind: 'assignment', weight: 7.5, status: 'not_started',
    group: { ...written, role: 'remainder' }, readState: { name: found, kind: found, weight: derived } }),
  assessment({ id: 'syn-a-exam', courseId: 'syn-course-a', name: 'Synthetic Systems final exam', kind: 'exam', weight: 30, hurdleMin: 40, isFinal: true, due: soon(5, '00:00:00Z'), status: 'not_started',
    group: { ...examGroup, role: 'component' }, readState: { name: found, kind: found, weight: found, isFinal: found, hurdleMin: found, due: derived } }),
  // Worth no marks (#192): folded into the collapsed section at the bottom of the course page.
  assessment({ id: 'syn-a-attendance', courseId: 'syn-course-a', name: 'Synthetic attendance hurdle', kind: 'participation', weight: 0, status: 'in_progress' }),
  assessment({ id: 'syn-b-lab', courseId: 'syn-course-b', name: 'Synthetic Lab Quiz', kind: 'quiz', weight: 15, score: 90, due: due(0, '05:00:00Z'), status: 'graded' }),
  // Weight unknown and never annotated.
  assessment({ id: 'syn-b-reflection', courseId: 'syn-course-b', name: 'Synthetic Weekly Reflection', kind: 'participation', due: soon(2), status: 'not_started' }),
  assessment({ id: 'syn-b-essay', courseId: 'syn-course-b', name: 'Synthetic Essay', kind: 'assignment', weight: 25, due: soon(4), status: 'not_started' }),
  assessment({ id: 'syn-b-exam', courseId: 'syn-course-b', name: 'Synthetic Ethics final exam', kind: 'exam', weight: 50, isFinal: true, due: soon(23, '00:00:00Z'), status: 'not_started' }),
];
const fetchedAt = new Date(Date.now() - 3600_000).toISOString();
const source = (id: string, courseId: string, platform: SourceItem['platform'], kind: SourceItem['kind'], title: string, text: string,
  extra: Partial<Pick<SourceItem, 'facts' | 'externalId' | 'copiedBy'>> = {}): SourceItem => ({
  id, platform, externalId: `${id}-external`, courseId, kind, title, text, contentHash: hash(text), fetchedAt, removed: false,
  // Evidence only accepts provider origins; the path is invented, so the UI link is exercised without naming real content.
  url: `https://canvas.lms.unimelb.edu.au/courses/900000/pages/${id}`, ...extra,
});
// Materials only count as evidence with page metadata, carried in the external id as source.record stores it.
const materialPage = (name: string, page: number) => JSON.stringify({ version: 1, kind: 'fetched-material', urlHash: hash(name), page, locator: `page:${page}` });
const texts = {
  outline: 'Synthetic Systems assessment outline. Quiz 2 is worth 5% of the final mark. Assignment 2 is worth 25% of the final mark and is due later this week. The final exam is worth 30% and has a 40% hurdle.',
  brief: 'Assignment 2 brief. Design a fictional scheduler for imaginary queues. Submit a short report and the source code. Reports longer than four pages lose marks.',
  lecture: 'Lecture 5 slides. Assignment 2 is an individual assignment marked out of 100.',
  week: 'Week notes. A synthetic scheduler allocates fictional work across imaginary queues. A round-robin scheduler gives each queue an equal time slice. Starvation happens when one queue never receives a slice.',
  policy: 'Synthetic Ethics Seminar policy. Generative AI tools are not permitted for any assessment in this subject.',
  ethics: 'Synthetic Ethics Seminar outline. The essay is worth 25% of the final mark. The lab quiz is worth 15%. The final exam is worth 50%.',
};
const sourceItems: SourceItem[] = [
  source('syn-src-a-outline', 'syn-course-a', 'canvas', 'announcement', 'Synthetic Systems subject outline', texts.outline),
  source('syn-src-a-brief', 'syn-course-a', 'canvas', 'assignment', 'Synthetic Assignment 2 brief', texts.brief, { facts: { due: soon(3), pointsPossible: 100, submitted: false } }),
  source('syn-src-a-week', 'syn-course-a', 'canvas', 'material', 'Synthetic week notes', texts.week, { externalId: materialPage('synthetic-week-notes', 1) }),
  // Text the agent copied from the owner's Edge with source.record; the drawer labels quotes from it.
  source('syn-src-a-lecture', 'syn-course-a', 'canvas', 'material', 'Synthetic lecture 5', texts.lecture, { externalId: materialPage('synthetic-lecture-5', 1), copiedBy: 'agent' }),
  // Points on the linked Canvas item let the course page show `36/50 · 72%` (#192).
  source('syn-src-a-assign-1', 'syn-course-a', 'canvas', 'assignment', 'Synthetic Assignment 1', '', { facts: { due: due(-7), pointsPossible: 50, pointsEarned: 36, submitted: true } }),
  source('syn-src-b-policy', 'syn-course-b', 'canvas', 'announcement', 'Synthetic AI policy', texts.policy),
  source('syn-src-b-outline', 'syn-course-b', 'canvas', 'announcement', 'Synthetic Ethics Seminar outline', texts.ethics),
];
const run = (id: string, startedAt: string, durationMs: number, edFailed: boolean): Run => ({
  id, command: 'sync', startedAt, endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), steps: 4,
  outcome: edFailed ? 'error' : 'ok', ...(edFailed ? { errorCode: 'AUTH_EXPIRED' } : {}), costUsd: 0, pages: 6, requests: 8, failures: edFailed ? 1 : 0,
  coverage: [
    { provider: 'canvas', collection: 'assignments', scopeRef: 'a'.repeat(64), planned: 4, attempted: 4, completed: 4, skipped: 0, failed: 0, notStarted: 0, codes: [] },
    { provider: 'ed', collection: 'lessons', scopeRef: 'b'.repeat(64), planned: 2, attempted: edFailed ? 1 : 2, completed: edFailed ? 0 : 2,
      skipped: 0, failed: edFailed ? 1 : 0, notStarted: edFailed ? 1 : 0, codes: edFailed ? ['AUTH_EXPIRED'] : [] },
  ],
});
const linkedAt = fetchedAt;
// One finished agent sync job: both courses stored from Canvas, Ed behind a sign-in page; course A left two fields unknown,
// course B's weights add up to 90 and its AI policy was newly read as prohibited. Three offered courses await the owner's choice.
const keys = courses.map(course => `${course.code}:${term}`);
const jobEnd = new Date(Date.parse(fetchedAt) + 95_000).toISOString();
store.saveCourseSelections([
  ...courses.map((course, index) => ({ key: keys[index]!, code: course.code, term, name: course.name, pages: {}, offeredAt: fetchedAt, selected: true, decidedAt: fetchedAt })),
  { key: `SYNC30003:${term}`, code: 'SYNC30003', term, name: 'Synthetic Undecided Elective', pages: {}, offeredAt: fetchedAt },
  { key: `SYND40004:${term}`, code: 'SYND40004', term, name: 'Synthetic Data Workshop', pages: {}, offeredAt: fetchedAt },
  { key: `SYNE50005:${term}`, code: 'SYNE50005', term, name: 'Synthetic Breadth Subject With A Rather Long Name For Wrapping', pages: {}, offeredAt: fetchedAt },
]);
const agentRun: Run = { id: 'syn-agent-sync', command: 'sync', startedAt: fetchedAt, endedAt: jobEnd, steps: 14, outcome: 'error', errorCode: 'PARTIAL', turns: 9,
  syncOutcome: 'PARTIAL', courseCoverage: keys.map((key, index) => ({ courseRef: hash(key), stored: true, submissions: index === 0 ? 3 : 1,
    unknownFields: index === 0 ? 2 : 0, platforms: { canvas: 'read', ed: 'blocked' }, policyChanged: index === 1 })) };
store.saveSyncJob({ id: 'syn-agent-sync', startedAt: fetchedAt, endedAt: jobEnd, courses: keys, submissions: { [keys[0]!]: 3, [keys[1]!]: 1 }, outcome: 'PARTIAL', blocked: ['ed'],
  results: {
    [keys[0]!]: { courseId: 'syn-course-a', storedAt: jobEnd, components: 4, items: 6, unknownFields: ['components[0].items[1].weight', 'components[2].items[1].due'], dropped: [],
      warnings: [], platforms: { canvas: 'read', ed: 'blocked' }, policyChanged: false },
    [keys[1]!]: { courseId: 'syn-course-b', storedAt: new Date(Date.parse(jobEnd) - 30_000).toISOString(), components: 4, items: 4, unknownFields: [], dropped: [],
      warnings: ['WEIGHT_SUM'], weightSum: 90, platforms: { canvas: 'read', ed: 'blocked' }, policyChanged: true },
  } });
store.saveBatch({
  modules, courses, assessments, sourceItems,
  runs: [run('syn-sync-failed', new Date(Date.now() - 2 * 86400_000).toISOString(), 41_000, true), run('syn-sync-ok', fetchedAt, 37_000, false), agentRun],
  assessmentLinks: [
    { assessmentId: 'syn-a-assign-2', sourceItemId: 'syn-src-a-brief', origin: 'sync', at: linkedAt },
    { assessmentId: 'syn-a-quiz-2', sourceItemId: 'syn-src-a-outline', origin: 'sync', at: linkedAt },
    { assessmentId: 'syn-a-assign-1', sourceItemId: 'syn-src-a-assign-1', origin: 'sync', at: linkedAt },
  ],
});

// A current and a superseded saved file for the same logical name: the current one is the content-updated notice
// until the owner opens it. The files exist only inside this temporary course folder.
const courseFolder = join(filesRoot, `UniMelb ${term.slice(2, 4)}${term.slice(-2)}`, 'Synthetic Systems');
mkdirSync(courseFolder, { recursive: true });
writeFileSync(join(courseFolder, 'instructions.html'), '<p>Synthetic assignment 2 instructions.</p>');
writeFileSync(join(courseFolder, 'instructions (2026-10-20).html'), '<p>Earlier synthetic instructions.</p>');
const savedAt = new Date(Date.parse(fetchedAt) + 60_000).toISOString();
const earlierSavedAt = new Date(Date.parse(fetchedAt) - 86400_000).toISOString();
const savedFiles: SavedFile[] = [
  { id: 'syn-saved-old', courseId: 'syn-course-a', assessmentId: 'syn-a-assign-2', path: 'instructions (2026-10-20).html',
    fingerprint: 'synthetic-old-fingerprint', savedAt: earlierSavedAt, supersededAt: earlierSavedAt },
  { id: 'syn-saved-current', courseId: 'syn-course-a', assessmentId: 'syn-a-assign-2', path: 'instructions.html',
    fingerprint: 'synthetic-current-fingerprint', savedAt },
];
for (const file of savedFiles) store.saveSavedFile(file);

// One open weight conflict and one unmatched Canvas item, both resolvable through check.resolve in the UI.
const conflicts: SyncConflict[] = [
  { id: 'syn-conflict-weight', courseId: 'syn-course-a', target: { componentKey: 'syna10001-assignments' }, field: 'weight',
    skeletonValue: 40, canvasValue: 45, state: 'open', checkedAt: fetchedAt },
  { id: 'syn-conflict-unmatched', courseId: 'syn-course-a', target: { canvasAssignmentId: 'syn-canvas-unlisted' }, field: 'unmatched',
    canvasValue: { id: 'syn-canvas-unlisted', name: 'Synthetic unlisted reflection', due: null }, state: 'open', checkedAt: fetchedAt },
];
for (const conflict of conflicts) store.saveSyncConflict(conflict);
await call('planning.settings.set', { timeZone, weekdayMinutes: [180, 120, 120, 180, 90, 240, 60], teachingWeekAnchor: addDays(monday, -63), breakWeeks: [7] });
await call('autonomy.policy.set', { courseId: 'syn-course-a', status: 'allowed' });
await call('autonomy.default.set', { courseId: 'syn-course-a', level: 1 });
await call('autonomy.override.set', { assessmentId: 'syn-a-assign-2', level: 2 });
// Course B keeps no owner policy: its effective policy is the agent-read one with its quote (#180).
await call('autonomy.default.set', { courseId: 'syn-course-b', level: 1 });

const quote = (sourceItemId: string, text: string, locator = sourceItemId) => ({ sourceItemId, quote: text, locator });
const revisionA = await sourceRevision('syn-course-a');
await call('annotation.record', { entity: 'assessment', entityId: 'syn-a-quiz-2', field: 'weight', value: 5, sourceRevision: revisionA,
  citations: [quote('syn-src-a-outline', 'Quiz 2 is worth 5% of the final mark.')] });
await call('annotation.record', { entity: 'assessment', entityId: 'syn-a-assign-2', field: 'kind', value: 'assignment', sourceRevision: revisionA,
  citations: [quote('syn-src-a-lecture', 'Assignment 2 is an individual assignment', 'page:1')] });

await call('estimate.agent.set', { workId: 'syn-a-assign-2', minutes: 300, reason: 'The brief asks for a report and source code.' });
await call('estimate.owner.set', { workId: 'syn-b-essay', minutes: 240 });
await call('time.record', { workId: 'syn-a-assign-2', minutes: 45 });
await call('manual.create', { moduleId: 'syn-module-personal', title: 'Synthetic study group', due: soon(0, '07:00:00Z'), estimateMinutes: 60 });
await call('manual.create', { moduleId: 'syn-module-personal', title: 'Synthetic library day', due: soon(2, '02:00:00Z'), allDay: true });
// A start time is only accepted on a day the planner already scheduled that work on.
const scope = { term, startDate: today, horizonDays: 7 };
const planned = (await call('plan.read', scope)).days as { date: string; items: { workId: string }[] }[];
const startDay = planned.find(day => day.items.some(item => item.workId === 'syn-a-assign-2'))?.date;
if (startDay) await call('plan.start.set', { ...scope, workId: 'syn-a-assign-2', date: startDay, time: '14:00' });

const notes = await call('revision.write', { courseId: 'syn-course-a', week: 10, sourceRevision: revisionA, claims: [
  { text: 'Round-robin scheduling gives every queue an equal time slice.', citations: [quote('syn-src-a-week', 'A round-robin scheduler gives each queue an equal time slice.', 'page:1')] },
  { text: 'Starvation means a queue never receives a slice.', citations: [quote('syn-src-a-week', 'Starvation happens when one queue never receives a slice.', 'page:1')] },
] });
const practice = await call('practice.write', { courseId: 'syn-course-a', week: 10, sourceRevision: revisionA, questions: [
  { id: 'syn-q-round-robin', prompt: 'What does a round-robin scheduler give each queue?', kind: 'objective',
    options: [{ id: 'equal', text: 'An equal time slice' }, { id: 'priority', text: 'A priority boost' }], answer: 'equal',
    explanation: [{ text: 'Each queue receives an equal slice.', citations: [quote('syn-src-a-week', 'A round-robin scheduler gives each queue an equal time slice.', 'page:1')] }] },
  { id: 'syn-q-starvation', prompt: 'Define starvation in your own words.', kind: 'open', answer: 'A queue that never receives a slice.',
    explanation: [{ text: 'Starvation is a queue never being served.', citations: [quote('syn-src-a-week', 'Starvation happens when one queue never receives a slice.', 'page:1')] }] },
] });
await call('practice.attempt.record', { questionId: 'syn-q-round-robin', revision: practice.revision, outcome: 'correct', at: now() });
await call('practice.attempt.record', { questionId: 'syn-q-starvation', revision: practice.revision, outcome: 'incorrect', at: now() });

// One finished chat so the conversation list and history are populated before any owner message.
const chat = await host.chat.create({ title: 'Synthetic assignment chat', courseId: 'syn-course-a', assessmentId: 'syn-a-assign-2' }, owner);
await host.chat.send(chat.id, 'Summarise the synthetic assignment brief.', owner);
await new Promise(done => setImmediate(done));
await host.chat.waitForIdle(chat.id);

// ---- Serve ---------------------------------------------------------------------------------------------------
let url = '';
const transport = await startOwnerUI(host, { isTTY: true, staticDirectory: join(root, 'dist', 'ui'), opener: async value => { url = value; } });

process.stdout.write([
  'coursework synthetic UI harness',
  `  data directory: ${home}`,
  `  origin:         ${transport.origin}`,
  `  open:           ${url}`,
  `  seeded:         ${courses.length} courses, ${assessments.length} assessments, ${sourceItems.length} sources, revision ${String(notes.revision)}, practice ${String(practice.revision)}`,
  'Press Ctrl-C to stop and remove the data directory.',
  '',
].join('\n'));

await new Promise<void>(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
try { await transport.close(); await host.close(); } finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
  process.stdout.write(`removed ${home}\n`);
}
