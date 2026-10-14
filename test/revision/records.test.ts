import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { hash } from '../../src/citations/exact.js';
const roots: string[] = []; const hosts: ReturnType<typeof createProductionProtocol>[] = [];
afterEach(async () => { hosts.splice(0).forEach(h => h.close()); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-records-'))); roots.push(root); vi.stubEnv('COURSEWORK_HOME', root);
  const host = createProductionProtocol(); hosts.push(host);
  host.store.saveCourse({ id: 'c', moduleId: 'm', code: 'SYN', name: 'Synthetic', term: 'test', assessmentsComplete: true, sources: [{ platform: 'canvas', externalId: '1' }] });
  host.store.saveSourceItem({ id: 's', externalId: 's', courseId: 'c', platform: 'canvas', kind: 'announcement', title: 'Synthetic exam scope', text: 'Trees. Recursion. Sorting.', contentHash: hash('Trees. Recursion. Sorting.'), fetchedAt: '2026-01-01T00:00:00Z' });
  const call = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const sourceRevision = ((await call('revision.read', { courseId: 'c' })) as { data: { sourceRevision: string } }).data?.sourceRevision;
  return { host, call, sourceRevision };
}
const claim = (quote: string) => ({ text: quote, citations: [{ sourceItemId: 's', quote, locator: 's' }] });
it('stores cited scope atomically, rejects one bad topic and reads effective final time after restart', async () => {
  const { host, call, sourceRevision } = await setup();
  expect(await call('revision.read', { courseId: 'c' })).toMatchObject({ ok: true, data: { examScope: null } });
  host.store.saveAssessment({ id: 'final', courseId: 'c', name: 'Synthetic final', kind: 'exam', isFinal: true, due: '2026-02-01T00:00:00Z', status: 'not_started' });
  host.store.appendAnnotation({ id: 'agent-due', entity: 'assessment', entityId: 'final', field: 'due', value: '2026-02-02T00:00:00Z', origin: 'agent', citations: [claim('Trees.').citations[0]!], at: '2026-01-01T00:00:00Z' });
  host.store.appendAnnotation({ id: 'owner-due', entity: 'assessment', entityId: 'final', field: 'due', value: '2026-02-03T00:00:00Z', origin: 'owner', citations: [], at: '2026-01-01T00:00:00Z' });
  const input = { courseId: 'c', type: 'exam-scope', sourceRevision, topics: ['Trees.', 'Recursion.', 'Sorting.'].map(claim) };
  const accepted = await call('revision.write', input);
  expect(accepted).toMatchObject({ ok: true });
  const revision = (accepted as { data: { revision: string } }).data.revision;
  expect(await call('revision.write', { ...input, previousRevision: revision, topics: [claim('Trees.'), claim('Invented')] })).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  host.close(); const next = createProductionProtocol(); hosts.push(next);
  expect(await dispatch(next.registry, 'revision.read', { courseId: 'c' }, next.context)).toMatchObject({ ok: true, data: { examTime: '2026-02-03T00:00:00Z', examScope: { revision, topics: input.topics } } });
  expect(await dispatch(next.registry, 'revision.list', { courseId: 'c' }, next.context)).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ type: 'exam-scope' })] } });
});
it('records no answer text, binds attempts to current questions and returns latest per-course results', async () => {
  const { host, call, sourceRevision } = await setup();
  const questions = ['q1', 'q2', 'q3'].map(id => ({ id, prompt: 'Name a topic.', kind: 'open', answer: 'Trees.', explanation: [claim('Trees.')] }));
  const accepted = await call('practice.write', { courseId: 'c', sourceRevision, questions });
  expect(accepted).toMatchObject({ ok: true }); const revision = (accepted as { data: { revision: string } }).data.revision;
  const record = (questionId: string, outcome: string, at: string) => call('practice.attempt.record', { questionId, revision, outcome, at });
  expect(await record('q1', 'incorrect', '2026-01-01T00:00:00Z')).toMatchObject({ ok: true });
  expect(await record('q2', 'incorrect', '2026-01-01T00:00:00Z')).toMatchObject({ ok: true });
  expect(await record('q2', 'correct', '2026-01-01T00:01:00Z')).toMatchObject({ ok: true });
  expect(await record('q3', 'skipped', '2026-01-01T00:00:00Z')).toMatchObject({ ok: true });
  expect(await call('practice.attempt.record', { questionId: 'q1', revision, outcome: 'correct', at: '2026-01-01T00:01:00Z', answer: 'private' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await record('missing', 'correct', '2026-01-01T00:00:00Z')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await call('practice.attempt.record', { questionId: 'q1', revision: '00000000-0000-4000-8000-000000000001', outcome: 'correct', at: '2026-01-01T00:00:00Z' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(host.store.readPracticeAttempts('q1')).toEqual([{ questionId: 'q1', revision, outcome: 'incorrect', at: '2026-01-01T00:00:00Z' }]);
  expect(await call('practice.stats', { courseId: 'c' })).toMatchObject({ ok: true, data: { questions: 3, attempted: 2, correct: 1, incorrect: 1, wrongQuestions: [{ questionId: 'q1', revision }] } });
  host.close(); const next = createProductionProtocol(); hosts.push(next);
  expect(await dispatch(next.registry, 'practice.stats', { courseId: 'c' }, next.context)).toMatchObject({ ok: true, data: { incorrect: 1 } });
});
it('keeps exam scope per course and rejects a teaching-week scope', async () => {
  const { call, sourceRevision } = await setup();
  expect(await call('revision.write', { courseId: 'c', week: 1, type: 'exam-scope', sourceRevision, topics: [claim('Trees.')] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
it('mounts source.fetch in production and names discussion refusals without fetching', async () => {
  const { host } = await setup();
  const read = vi.fn(async (url: string) => ({ url, status: 200, contentType: 'text/plain', body: new Uint8Array(Buffer.from('Synthetic fetched content.')) }));
  const mounted = createProductionProtocol({ store: host.store, sourceTransport: { read } }); hosts.push(mounted);
  const result = await dispatch(mounted.registry, 'source.fetch', { courseId: 'c', url: 'https://canvas.lms.unimelb.edu.au/courses/1/pages/lecture' }, mounted.context);
  expect(result).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ text: 'Synthetic fetched content.' })] } });
  expect(await dispatch(mounted.registry, 'source.fetch', { courseId: 'c', url: 'https://edstem.org/api/threads/1' }, mounted.context)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Discussion') } });
  expect(read).toHaveBeenCalledOnce();
});
it('rejects duplicate practice question ids without replacing the accepted record', async () => {
  const { call, sourceRevision } = await setup();
  const question = { id: 'q', prompt: 'Name a topic.', kind: 'open', answer: 'Trees.', explanation: [claim('Trees.')] };
  const initial = await call('practice.write', { courseId: 'c', sourceRevision, questions: [question] });
  expect(initial).toMatchObject({ ok: true });
  const revision = (initial as { data: { revision: string } }).data.revision;
  expect(await call('practice.write', { courseId: 'c', sourceRevision, previousRevision: revision, questions: [question, { ...question, prompt: 'Another topic?' }] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await call('practice.list', { courseId: 'c' })).toMatchObject({ ok: true, data: { items: [{ revision, questions: [question] }] } });
});
it('reports external redirect refusals through the production command', async () => {
  const { host } = await setup();
  const mounted = createProductionProtocol({ store: host.store, sourceTransport: { read: async () => ({ url: 'https://example.org/file', status: 302, contentType: 'text/plain', body: new Uint8Array() }) } }); hosts.push(mounted);
  expect(await dispatch(mounted.registry, 'source.fetch', { courseId: 'c', url: 'https://canvas.lms.unimelb.edu.au/courses/1/pages/lecture' }, mounted.context)).toMatchObject({ ok: false, error: { message: expect.stringContaining('Redirects') } });
});

it('selects the final using owner-over-agent annotations in both directions and reads its effective due', async () => {
  const { host, call } = await setup();
  for (const [id, isFinal] of [['old', true], ['new', false]] as const) {
    host.store.saveAssessment({ id, courseId: 'c', name: 'Synthetic final', kind: 'exam', isFinal, due: '2026-02-01T00:00:00Z', status: 'not_started' });
    host.store.appendAnnotation({ id: `owner-${id}`, entity: 'assessment', entityId: id, field: 'isFinal', value: !isFinal, origin: 'owner', citations: [], at: '2026-01-01T00:00:00Z' });
    host.store.appendAnnotation({ id: `agent-${id}`, entity: 'assessment', entityId: id, field: 'isFinal', value: isFinal, origin: 'agent', citations: claim('Trees.').citations, at: '2026-01-02T00:00:00Z' });
  }
  host.store.appendAnnotation({ id: 'due-new', entity: 'assessment', entityId: 'new', field: 'due', value: '2026-02-03T00:00:00Z', origin: 'owner', citations: [], at: '2026-01-01T00:00:00Z' });
  expect(await call('revision.read', { courseId: 'c' })).toMatchObject({ ok: true, data: { finalAssessmentId: 'new', examTime: '2026-02-03T00:00:00Z' } });
});

it('refuses unreadable study publication and pages readable records by response bytes after restart', async () => {
  const { host, call } = await setup();
  const quote = 'x'.repeat(35_000);
  host.store.saveSourceItem({ id: 's', externalId: 's', courseId: 'c', platform: 'canvas', kind: 'announcement', title: 'Synthetic large source', text: quote, contentHash: hash(quote), fetchedAt: '2026-01-01T00:00:00Z' });
  const sourceRevision = (await call('revision.read', { courseId: 'c' }) as { data: { sourceRevision: string } }).data.sourceRevision;
  const initial = await call('revision.write', { courseId: 'c', sourceRevision, claims: [claim('x')] });
  expect(initial).toMatchObject({ ok: true });
  const revision = (initial as { data: { revision: string } }).data.revision;
  expect(await call('revision.write', { courseId: 'c', sourceRevision, previousRevision: revision, claims: [{ ...claim(quote), text: 'Synthetic claim' }] })).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
  const accepted = [];
  for (const week of [1, 2]) {
    const result = await call('revision.write', { courseId: 'c', week, sourceRevision, claims: [{ ...claim(quote.slice(0, 20_000)), text: 'Synthetic claim' }] });
    expect(result).toMatchObject({ ok: true });
    accepted.push((result as { data: { revision: string } }).data.revision);
  }
  host.close(); const next = createProductionProtocol(); hosts.push(next);
  let cursor: string | undefined;
  const items: { revision: string }[] = [];
  let pages = 0;
  do {
    const result = await dispatch(next.registry, 'revision.list', { courseId: 'c', limit: 100, cursor }, next.context);
    expect(result).toMatchObject({ ok: true });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    const data = (result as { data: { items: { revision: string }[]; nextCursor?: string } }).data;
    items.push(...data.items); cursor = data.nextCursor; pages++;
    expect(pages).toBeLessThanOrEqual(3);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(items.map(item => item.revision).sort()).toEqual([revision, ...accepted].sort());
});
