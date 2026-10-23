import { expect, it, vi } from 'vitest';
import { retryable } from '../../src/protocol/errors.js';
import { createClient } from '../../web/src/client.js';
import { levelView, recordedPolicy } from '../../web/src/course.js';
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
  fields: { weight: field(5, 'agent', { annotationId: 'ann-1', citations: [citation] }), kind: field('quiz', 'sync') } };
const scope = { id: 'scope', revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', courseId: 'c1', sourceRevision: hash, type: 'exam-scope',
  topics: [{ text: 'Scheduling', citations: [citation] }], citations: [{ ...citation, offset: 0, end: 19, sourceHash: hash }], limitations: [] };
const note = { ...scope, id: 'note', type: 'note', claims: scope.topics, topics: undefined };
function fixture(overrides: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const command = String(url).slice(5);
    const input = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
      'courses.list': () => page([course]), 'assessments.list': () => page([quiz]),
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
  expect(recordedPolicy(state.course?.fields?.aiPolicy)).toBe('allowed');
  expect(state.assessments?.map(item => item.id)).toEqual(['quiz']);
  expect(state.work?.quiz).toMatchObject({ estimateMinutes: 60, estimateOrigin: 'agent', actualMinutes: 30 });
  expect(calls(fetcher, 'plan.read')[0]!.body).toMatchObject({ term: '2026-S2', horizonDays: 1 });
  expect(state.revision?.examScope?.topics).toHaveLength(1);
  expect(state.notes?.map(record => record.id)).toEqual(['note']);
  expect(state.stats).toMatchObject({ incorrect: 1 });
});

it('saves an assessment level through the owner session and shows the new effective level', async () => {
  const fetcher = fixture();
  const store = new CourseStore(createClient(secret, fetcher), 'c1');
  await store.load();
  expect(levelView(quiz, 'allowed', store.getSnapshot().known)).toEqual({ kind: 'unknown' });
  expect(await store.setOverride('quiz', 1)).toBe(true);
  expect(calls(fetcher, 'autonomy.override.set')).toEqual([{ body: { assessmentId: 'quiz', level: 1 }, session: secret }]);
  expect(levelView(quiz, 'allowed', store.getSnapshot().known)).toEqual({ kind: 'level', level: 1, source: 'override' });
  expect(await store.setDefault(2)).toBe(true);
  expect(await store.setOverride('quiz', null)).toBe(true);
  expect(calls(fetcher, 'autonomy.override.clear')[0]!.body).toEqual({ assessmentId: 'quiz' });
  expect(levelView(quiz, 'allowed', store.getSnapshot().known)).toEqual({ kind: 'level', level: 2, source: 'default' });
});

it('shows save errors and changes nothing locally when a write is refused or the session is missing', async () => {
  const anonymous = new CourseStore(createClient(undefined, fixture()), 'c1');
  expect(await anonymous.setConfirm(false)).toBe(false);
  expect(anonymous.getSnapshot().errors.write).toBe('OWNER_SESSION_EXPIRED');
  const refused = new CourseStore(createClient(secret, fixture({ 'autonomy.default.set': () => { throw new Error('CONFLICT'); } })), 'c1');
  expect(await refused.setDefault(1)).toBe(false);
  expect(refused.getSnapshot()).toMatchObject({ errors: { write: 'CONFLICT' }, known: { overrides: {} } });
  expect(refused.getSnapshot().known.defaultLevel).toBeUndefined();
});

it('opens an agent value with its cited quote and the source link, then records the owner verdicts', async () => {
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
  expect(await store.replace('assessment', 'quiz', 'weight', 4, 'ann-1')).toBe(true);
  expect(calls(fetcher, 'annotation.confirm')[0]).toEqual({ body: { entity: 'assessment', entityId: 'quiz', field: 'weight', annotationId: 'ann-1' }, session: secret });
  expect(calls(fetcher, 'annotation.replace')[0]!.body).toEqual({ entity: 'assessment', entityId: 'quiz', field: 'weight', value: 4, annotationId: 'ann-1' });
  // Verdicts change effective values, so the assessments and the drawer are read again.
  expect(calls(fetcher, 'assessments.list').length).toBe(3);
  expect(await store.setEstimate('quiz', 45)).toBe(true);
  expect(await store.recordTime('quiz', 20)).toBe(true);
  expect(calls(fetcher, 'estimate.owner.set')[0]!.body).toEqual({ workId: 'quiz', minutes: 45 });
  expect(calls(fetcher, 'time.record')[0]!.body).toEqual({ workId: 'quiz', minutes: 20 });
  expect(calls(fetcher, 'plan.read').length).toBe(3);
});
