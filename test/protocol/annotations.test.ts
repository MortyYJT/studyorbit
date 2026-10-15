import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hash } from '../../src/citations/exact.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { courseEvidenceSnapshot, materialIdentity } from '../../src/revision/source-fetch.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'annotation-test-')));
  const store = new SqliteRepository(join(directory, 'test.sqlite'));
  const files = new ProtocolFiles(join(directory, 'journal'));
  const host = createProductionProtocol({ store, files, owner: { assertOwner: async () => {} } });
  cleanups.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.saveBatch({ modules: [{ id: 'm', name: 'Synthetic', glyph: 'S', auto: false }],
    courses: ['c', 'other'].map(id => ({ id, moduleId: 'm', code: 'SYN10001', name: 'Synthetic', term: 'Synthetic', assessmentsComplete: false })),
    assessments: ['a', 'b'].map(id => ({ id, courseId: 'c', name: 'Synthetic assessment', weight: 20, isFinal: false, status: 'not_started' })),
    sourceItems: [{ id: 'syllabus', platform: 'manual', externalId: materialIdentity('https://example.test/syllabus', 1), courseId: 'c', kind: 'material',
      title: 'Synthetic syllabus', text: 'Final exam (40%). Workshops 10%. quiz', contentHash: hash('Final exam (40%). Workshops 10%. quiz'), fetchedAt: '2026-01-01T00:00:00Z' },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}`, platform: 'ed' as const, externalId: String(i), courseId: 'c', kind: 'assignment' as const,
      title: 'Synthetic workshop', text: 'Workshop', contentHash: hash('Workshop'), fetchedAt: '2026-01-01T00:00:00Z' })),
    { id: 'foreign', platform: 'ed', externalId: 'foreign', courseId: 'other', kind: 'assignment', title: 'Other', text: 'Other', contentHash: hash('Other'), fetchedAt: '2026-01-01T00:00:00Z' }] });
  const call = (name: string, input: unknown, owner = false) => dispatch(host.registry, name, input, owner ? host.context : host.registry.agentTools(host.context).context);
  const revision = () => courseEvidenceSnapshot(store, new TrustedStoreEvidence(store), 'c').sourceRevision;
  const cite = (quote = 'Final exam (40%)') => [{ sourceItemId: 'syllabus', locator: 'page:1', quote }];
  const annotate = (field = 'weight', value: unknown = 40, extra = {}) => call('annotation.record', { entity: 'assessment', entityId: 'a', field, value, sourceRevision: revision(), citations: cite(), ...extra });
  const read = (id = 'a', entity = 'assessment') => call('annotation.read', { entity, entityId: id });
  return { ...host, files, call, revision, cite, annotate, read };
}
it('6.1 applies a cited syllabus weight with an openable quote and receipt', async () => {
  const f = await fixture();
  expect(await f.annotate()).toMatchObject({ ok: true, data: { citations: [{ sourceItemId: 'syllabus', quote: 'Final exam (40%)', page: 1, offset: 0 }] } });
  expect(await f.read()).toMatchObject({ ok: true, data: { fields: { weight: { value: 40, origin: 'agent', citations: f.cite() } } } });
  expect(await f.call('sources.get', { sourceItemId: 'syllabus' })).toMatchObject({ ok: true, data: { text: expect.stringContaining('Final exam (40%)') } });
});
it('6.1 rejects an invented quote without mutation and records the rejection', async () => {
  const f = await fixture();
  expect(await f.annotate('weight', 99, { citations: f.cite('Invented quote') })).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect(f.store.readAnnotations('assessment', 'a')).toEqual([]);
  expect(f.store.loadAssessment('a')?.weight).toBe(20);
  expect(await f.files.readLog('runs')).toEqual([expect.objectContaining({ command: 'annotation.record', outcome: 'error', errorCode: 'CITATION_MISMATCH' })]);
});
it('6.1 rejects a stale source revision and preserves accepted history', async () => {
  const f = await fixture(); await f.annotate(); const old = f.revision();
  f.store.saveSourceItem({ ...f.store.loadSourceItem('syllabus')!, text: 'Changed syllabus', contentHash: hash('Changed syllabus') });
  expect(await f.annotate('weight', 50, { sourceRevision: old })).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect(f.store.readAnnotations('assessment', 'a')).toHaveLength(1);
});
it('6.2 creates one syllabus-only assessment, links ten items and moves one with history', async () => {
  const f = await fixture();
  const created = await f.call('assessment.create', { courseId: 'c', sourceRevision: f.revision(), name: { value: 'Workshops', citations: f.cite('Workshops') }, weight: { value: 10, citations: f.cite('10%') } });
  expect(created).toMatchObject({ ok: true }); if (!created.ok) return;
  const id = (created.data as { id: string }).id;
  for (let i = 0; i < 10; i++) expect(await f.call('assessment.link', { assessmentId: id, sourceItemId: `item-${i}`, sourceRevision: f.revision() })).toMatchObject({ ok: true });
  expect(await f.read(id)).toMatchObject({ data: { fields: { name: { value: 'Workshops' }, weight: { value: 10 } }, links: expect.arrayContaining([{ assessmentId: id, sourceItemId: 'item-0', origin: 'agent', at: expect.any(String) }]) } });
  expect(f.store.readAssessmentLinks(id)).toHaveLength(10);
  expect(await f.call('assessment.link', { assessmentId: 'b', sourceItemId: 'item-0', sourceRevision: f.revision() })).toMatchObject({ ok: true });
  const old = await f.read(id); expect(old).toMatchObject({ data: { links: expect.any(Array) } });
  if (old.ok) expect((old.data as { links: unknown[] }).links).toHaveLength(9);
  expect(f.store.readAssessmentLinks(id)).toHaveLength(10);
  expect(await f.read('b')).toMatchObject({ data: { links: [{ sourceItemId: 'item-0', origin: 'agent' }] } });
});
it('6.2 rejects cross-course links without appending history', async () => {
  const f = await fixture();
  expect(await f.call('assessment.link', { assessmentId: 'a', sourceItemId: 'foreign', sourceRevision: f.revision() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(f.store.readAssessmentLinks('a')).toEqual([]);
});
it('6.3 uses newest owner over newer agent over sync, retains history and exposes verdicts', async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({ data: { fields: { weight: { value: 20, origin: 'sync', citations: [] } } } });
  await f.annotate('weight', 30); await f.call('annotation.owner.record', { entity: 'assessment', entityId: 'a', field: 'weight', value: 25 }, true);
  await f.annotate('weight', 35);
  expect(await f.read()).toMatchObject({ data: { fields: { weight: { value: 25, origin: 'owner', citations: [] } }, history: [{ value: 30, verdicts: [] }, { value: 25 }, { value: 35 }] } });
  expect(f.store.loadAssessment('a')?.weight).toBe(20);
  expect(await f.call('assessments.list', { courseId: 'c' })).toMatchObject({ data: { items: [expect.objectContaining({ id: 'a', weight: 25 }), expect.anything()] } });
});
it('6.3 leaves classification unknown and requires L2 for unknown work', async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({ data: { fields: { kind: { value: null, origin: null } } } });
  await f.call('autonomy.default.set', { courseId: 'c', level: 1 }, true);
  expect(await f.call('autonomy.check', { assessmentId: 'a', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'grant-level' } });
});
it('6.4 confirm keeps agent kind and appends correct verdict; agents cannot confirm', async () => {
  const f = await fixture(); await f.annotate('kind', 'quiz', { citations: f.cite('quiz') });
  const input = { entity: 'assessment', entityId: 'a', field: 'kind', annotationId: f.store.readAnnotations('assessment', 'a')[0]!.id };
  expect(await f.call('annotation.confirm', input)).toMatchObject({ ok: false });
  expect(await f.call('annotation.confirm', input, true)).toMatchObject({ ok: true });
  expect(await f.read()).toMatchObject({ data: { fields: { kind: { value: 'quiz', origin: 'agent', verdicts: [{ verdict: 'correct' }] } } } });
});
it('6.4 use my value atomically records owner value and incorrect verdict; agents refused', async () => {
  const f = await fixture(); await f.annotate('weight', 30);
  const input = { entity: 'assessment', entityId: 'a', field: 'weight', annotationId: f.store.readAnnotations('assessment', 'a')[0]!.id, value: 25 };
  expect(await f.call('annotation.replace', input)).toMatchObject({ ok: false });
  expect(await f.call('annotation.replace', input, true)).toMatchObject({ ok: true });
  expect(await f.read()).toMatchObject({ data: { fields: { weight: { value: 25, origin: 'owner' } }, history: [{ verdicts: [{ verdict: 'incorrect' }] }, { origin: 'owner' }] } });
  expect(await f.call('annotation.confirm', { entity: input.entity, entityId: input.entityId, field: input.field, annotationId: input.annotationId }, true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
});
it('rejects unsafe, malformed and wrong-course annotation claims without publication', async () => {
  const f = await fixture();
  for (const extra of [{ value: 101 }, { value: 'person@example.test' }, { field: 'status', value: 'graded' }, { citations: [] },
    { citations: [{ sourceItemId: 'foreign', locator: 'foreign', quote: 'Other' }] }, { origin: 'owner' }]) {
    expect(await f.annotate('weight', 40, extra)).toMatchObject({ ok: false });
    expect(f.store.readAnnotations('assessment', 'a')).toHaveLength(0);
  }
  expect(await f.annotate('name', 'person@example.test')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await f.call('assessment.create', { courseId: 'c', sourceRevision: f.revision(), name: { value: 'Workshops', citations: f.cite('Workshops') }, weight: { value: 10, citations: f.cite('Invented') } })).toMatchObject({ ok: false });
  expect(f.store.query('assessments', { courseId: 'c', limit: 100 }).items).toHaveLength(2);
});
it('lists and filters the effective annotated kind, including clearing to unknown', async () => {
  const f = await fixture(); await f.annotate('kind', 'quiz', { citations: f.cite('quiz') });
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'quiz' })).toMatchObject({ data: { items: [expect.objectContaining({ id: 'a', kind: 'quiz' })] } });
  await f.call('annotation.owner.record', { entity: 'assessment', entityId: 'a', field: 'kind', value: null }, true);
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'quiz' })).toMatchObject({ data: { items: [] } });
});
it('course policy text never changes the owner-only autonomy grant or its prohibited cap', async () => {
  const f = await fixture();
  await f.call('autonomy.policy.set', { courseId: 'c', status: 'prohibited' }, true);
  await f.call('autonomy.default.set', { courseId: 'c', level: 2 }, true);
  expect(await f.call('annotation.record', { entity: 'course', entityId: 'c', field: 'aiPolicy', value: 'Policy from syllabus', sourceRevision: f.revision(), citations: f.cite() })).toMatchObject({ ok: true });
  expect(await f.call('annotation.owner.record', { entity: 'course', entityId: 'c', field: 'aiPolicy', value: 'Owner policy text' }, true)).toMatchObject({ ok: true });
  expect(await f.call('autonomy.check', { assessmentId: 'a', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'course-prohibited' } });
});
it('course completeness coverage follows the effective annotated value', async () => {
  const f = await fixture();
  expect(await f.call('annotation.record', { entity: 'course', entityId: 'c', field: 'assessmentsComplete', value: true, sourceRevision: f.revision(), citations: f.cite() })).toMatchObject({ ok: true });
  const result = await f.call('courses.list', {});
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    const page = result.data as { items: { id: string; assessmentsComplete: boolean }[]; coverage: { gaps: { code: string; reference?: string }[] } };
    expect(page.items.find(item => item.id === 'c')?.assessmentsComplete).toBe(true);
    expect(page.coverage.gaps).not.toContainEqual({ code: 'INCOMPLETE', reference: 'c' });
  }
});
