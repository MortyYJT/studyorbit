import { expect, it, vi } from 'vitest';
import { retryable } from '../../src/protocol/errors.js';
import { createClient } from '../../web/src/client.js';
import { levelView } from '../../web/src/course.js';
import { CourseStore } from '../../web/src/course-store.js';

const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const page = (items: unknown[] = []) => ({ items, evidence: [], coverage: { complete: true, gaps: [] } });
const secret = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const field = (value: unknown, origin: 'owner' | 'agent' | 'sync' | null, extra = {}) => ({ value, origin, citations: [], verdicts: [], ...extra });
const citation = { sourceItemId: 'src-outline', quote: 'Quiz 2 is worth 5%.', locator: 'src-outline' };
const course = { id: 'c1', moduleId: 'm1', code: 'SYNA10001', name: 'Synthetic', term: '2026-S2', assessmentsComplete: false,
  fields: { assessmentsComplete: field(false, 'sync'), aiPolicy: field('allowed', 'owner') } };
const quiz = { id: 'quiz', courseId: 'c1', name: 'Quiz 2', kind: 'quiz', weight: 5, isFinal: false, status: 'not_started',
  fields: { weight: field(5, 'agent', { annotationId: 'ann-1', citations: [citation] }), kind: field('quiz', 'agent', { annotationId: 'ann-2', citations: [citation] }) } };
const graded = { id: 'graded', courseId: 'c1', name: 'Quiz 1', kind: 'quiz', weight: 5, score: 80, isFinal: false, status: 'graded' };
/** Server-side autonomy state the fixture's writes change and autonomy.read returns. */
function autonomyServer() {
  const state = { defaultLevel: 0 as 0 | 1 | 2, override: null as 0 | 1 | 2 | null };
  return {
    'autonomy.read': () => ({ courseId: 'c1', policy: 'allowed', policyOrigin: 'owner', cap: 2, defaultLevel: state.defaultLevel,
      assessments: [{ assessmentId: 'quiz', kind: 'quiz', applicable: true, requiredLevel: 1, override: state.override, effectiveLevel: state.override ?? state.defaultLevel }] }),
    'autonomy.override.set': (input: Record<string, unknown>) => { state.override = input.level as 0 | 1 | 2; return { recorded: true }; },
    'autonomy.override.clear': () => { state.override = null; return { recorded: true }; },
    'autonomy.default.set': (input: Record<string, unknown>) => { state.defaultLevel = input.level as 0 | 1 | 2; return { recorded: true }; },
  };
}
const scope = { id: 'scope', revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', courseId: 'c1', sourceRevision: hash, type: 'exam-scope',
  topics: [{ text: 'Scheduling', citations: [citation] }], citations: [{ ...citation, offset: 0, end: 19, sourceHash: hash }], limitations: [] };
const note = { ...scope, id: 'note', type: 'note', claims: scope.topics, topics: undefined };
function fixture(overrides: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  const autonomy = autonomyServer();
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const command = String(url).slice(5);
    const input = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
      'courses.list': () => page([course]), 'assessments.list': () => page([quiz, graded]), ...autonomy,
      'plan.read': () => ({ days: [], work: [{ workId: 'quiz', title: 'Quiz 2', actualMinutes: 30, estimateMinutes: 60, estimateOrigin: 'agent', agentEstimate: { minutes: 60, reason: 'Ten short questions.' } }], overflow: [], unestimated: [], deadlines: [] }),
      'revision.read': () => ({ sourceRevision: hash, examScope: scope, examTime: '2026-11-20T09:00:00+11:00', finalAssessmentId: 'exam' }),
      'revision.list': () => page([scope, Object.fromEntries(Object.entries(note).filter(([, value]) => value !== undefined))]),
      'practice.stats': () => ({ questions: 2, attempted: 2, correct: 1, incorrect: 1, wrongQuestions: [{ questionId: 'q2', revision: scope.revision }] }),
      'annotation.read': value => ({ entity: value.entity, entityId: value.entityId, fields: value.entity === 'course' ? course.fields : quiz.fields,
        history: [], coverage: { complete: true, gaps: [] }, links: value.entity === 'course' ? [] : [{ assessmentId: 'quiz', sourceItemId: 'src-outline', origin: 'sync', at: '2026-10-01T00:00:00Z' }] }),
      'tasks.list': () => page(),
      'sources.get': () => ({ sourceItemId: 'src-outline', courseId: 'c1', text: 'Quiz 2 is worth 5%.', sourceHash: hash, locator: 'src-outline',
        provenance: 'canvas', url: 'https://canvas.example.test/courses/1/pages/outline', redacted: true }),
      ...overrides,
    };
    const handler = handlers[command] ?? (() => ({ recorded: true }));
    try {
      return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: true, data: handler(input), meta }));
    } catch (error) {
      return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: false, meta,
        error: { code: (error as Error).message, message: 'Failed.', retryable: retryable[(error as Error).message as keyof typeof retryable] } }), { status: 409 });
    }
  });
}
const calls = (fetcher: ReturnType<typeof fixture>, command: string) => fetcher.mock.calls.filter(([url]) => url === `/api/${command}`)
  .map(([, init]) => ({ body: JSON.parse(String(init?.body)), session: new Headers(init?.headers).get('X-Coursework-Session') }));

it('loads the course, its assessments, estimates and revision data through registry reads', async () => {
  const fetcher = fixture();
  const store = new CourseStore(createClient(undefined, fetcher), 'c1');
  await store.load();
  const state = store.getSnapshot();
  expect(state.course?.code).toBe('SYNA10001');
  expect(state.autonomy).toMatchObject({ policy: 'allowed', defaultLevel: 0 });
  expect(state.assessments?.map(item => item.id)).toEqual(['quiz', 'graded']);
  expect(state.work?.quiz).toMatchObject({ estimateMinutes: 60, estimateOrigin: 'agent', actualMinutes: 30 });
  expect(calls(fetcher, 'plan.read')[0]!.body).toMatchObject({ term: '2026-S2', horizonDays: 1 });
  expect(state.revision?.examScope?.topics).toHaveLength(1);
  expect(state.notes?.map(record => record.id)).toEqual(['note']);
  expect(state.stats).toMatchObject({ incorrect: 1 });
});

it('saves an assessment level through the owner session and shows the effective level re-read from the server', async () => {
  const fetcher = fixture();
  const store = new CourseStore(createClient(secret, fetcher), 'c1');
  await store.load();
  expect(levelView(quiz, store.getSnapshot().autonomy)).toEqual({ kind: 'level', level: 0, source: 'default' });
  expect(await store.setOverride('quiz', 1)).toBe(true);
  expect(calls(fetcher, 'autonomy.override.set')).toEqual([{ body: { assessmentId: 'quiz', level: 1 }, session: secret }]);
  expect(levelView(quiz, store.getSnapshot().autonomy)).toEqual({ kind: 'level', level: 1, source: 'override' });
  expect(await store.setDefault(2)).toBe(true);
  expect(await store.setOverride('quiz', null)).toBe(true);
  expect(calls(fetcher, 'autonomy.override.clear')[0]!.body).toEqual({ assessmentId: 'quiz' });
  expect(store.getSnapshot().autonomy).toMatchObject({ defaultLevel: 2 });
  expect(levelView(quiz, store.getSnapshot().autonomy)).toEqual({ kind: 'level', level: 2, source: 'default' });
  // One initial read plus one after each of the three writes; nothing is computed locally.
  expect(calls(fetcher, 'autonomy.read')).toHaveLength(4);
});

it('shows save errors and changes nothing when a write is refused or the session is missing', async () => {
  const anonymous = new CourseStore(createClient(undefined, fixture()), 'c1');
  expect(await anonymous.setDefault(1)).toBe(false);
  expect(anonymous.getSnapshot().errors.write).toBe('OWNER_SESSION_EXPIRED');
  const refused = new CourseStore(createClient(secret, fixture({ 'autonomy.default.set': () => { throw new Error('CONFLICT'); } })), 'c1');
  await refused.load();
  expect(await refused.setDefault(1)).toBe(false);
  expect(refused.getSnapshot()).toMatchObject({ errors: { write: 'CONFLICT' }, autonomy: { defaultLevel: 0 } });
});

it('opens an agent value with its cited quote and the source link, then records one owner verdict per annotation', async () => {
  const fetcher = fixture();
  const store = new CourseStore(createClient(secret, fetcher), 'c1');
  await store.load();
  await store.openAssessment('quiz');
  expect(store.getSnapshot().details.quiz?.fields.weight).toMatchObject({ origin: 'agent', citations: [citation] });
  expect(store.getSnapshot().details.quiz?.links.map(link => link.sourceItemId)).toEqual(['src-outline']);
  await store.source('src-outline');
  await store.source('src-outline');
  expect(store.getSnapshot().sources['src-outline']?.url).toBe('https://canvas.example.test/courses/1/pages/outline');
  expect(calls(fetcher, 'sources.get')).toHaveLength(1);
  expect(await store.confirm('assessment', 'quiz', 'weight', 'ann-1')).toBe(true);
  expect(await store.replace('assessment', 'quiz', 'kind', 'assignment', 'ann-2')).toBe(true);
  expect(calls(fetcher, 'annotation.confirm')).toEqual([{ body: { entity: 'assessment', entityId: 'quiz', field: 'weight', annotationId: 'ann-1' }, session: secret }]);
  expect(calls(fetcher, 'annotation.replace')).toEqual([{ body: { entity: 'assessment', entityId: 'quiz', field: 'kind', value: 'assignment', annotationId: 'ann-2' }, session: secret }]);
  // Verdicts change effective values (and a kind changes the required level), so these are read again.
  expect(calls(fetcher, 'assessments.list').length).toBe(3);
  expect(calls(fetcher, 'autonomy.read').length).toBe(3);
});

it('records estimates and actual time, including for graded work outside the plan', async () => {
  const fetcher = fixture();
  const store = new CourseStore(createClient(secret, fetcher), 'c1');
  await store.load();
  expect(store.getSnapshot().work?.graded).toBeUndefined();
  expect(await store.setEstimate('quiz', 45)).toBe(true);
  expect(await store.recordTime('graded', 20)).toBe(true);
  expect(calls(fetcher, 'estimate.owner.set')[0]!.body).toEqual({ workId: 'quiz', minutes: 45 });
  expect(calls(fetcher, 'time.record')[0]).toEqual({ body: { workId: 'graded', minutes: 20 }, session: secret });
  expect(store.getSnapshot().recorded).toEqual({ graded: 20 });
  expect(calls(fetcher, 'plan.read').length).toBe(3);
});

it('Agent-copied source: concurrent source reads all land, and the copied marker reaches the drawer state', async () => {
  const fetcher = fixture({ 'sources.get': input => ({ sourceItemId: input.sourceItemId, courseId: 'c1', text: 'Synthetic text.', sourceHash: hash,
    locator: 'page:1', page: 1, provenance: 'canvas', redacted: true, ...(input.sourceItemId === 'copied' ? { copiedBy: 'agent' } : {}) }) });
  const store = new CourseStore(createClient(undefined, fetcher), 'c1');
  await Promise.all([store.source('platform'), store.source('copied')]);
  expect(Object.keys(store.getSnapshot().sources).sort()).toEqual(['copied', 'platform']);
  expect(store.getSnapshot().sources.copied).toMatchObject({ copiedBy: 'agent' });
  expect(store.getSnapshot().sources.platform).not.toHaveProperty('copiedBy');
});
