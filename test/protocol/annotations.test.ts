import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validateCourseDocument } from '../../src/sync/course-json.js';
import { assessmentId, importCourseDocument } from '../../src/sync/course-import.js';
import { component, document, item, now, quoted } from '../sync/course-document.js';
import { hash } from '../../src/citations/exact.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { courseEvidenceSnapshot, materialIdentity } from '../../src/revision/sources.js';
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
it('rejects malformed and wrong-course annotation claims without publication', async () => {
  const f = await fixture();
  for (const extra of [{ value: 101 }, { value: 'person@example.test' }, { field: 'status', value: 'graded' }, { citations: [] },
    { citations: [{ sourceItemId: 'foreign', locator: 'foreign', quote: 'Other' }] }, { origin: 'owner' }]) {
    expect(await f.annotate('weight', 40, extra)).toMatchObject({ ok: false });
    expect(f.store.readAnnotations('assessment', 'a')).toHaveLength(0);
  }
  expect(await f.call('assessment.create', { courseId: 'c', sourceRevision: f.revision(), name: { value: 'Workshops', citations: f.cite('Workshops') }, weight: { value: 10, citations: f.cite('Invented') } })).toMatchObject({ ok: false });
  expect(f.store.query('assessments', { courseId: 'c', limit: 100 }).items).toHaveLength(2);
});
it('lists and filters the effective annotated kind, including clearing to unknown', async () => {
  const f = await fixture(); await f.annotate('kind', 'quiz', { citations: f.cite('quiz') });
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'quiz' })).toMatchObject({ data: { items: [expect.objectContaining({ id: 'a', kind: 'quiz' })] } });
  await f.call('annotation.owner.record', { entity: 'assessment', entityId: 'a', field: 'kind', value: null }, true);
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'quiz' })).toMatchObject({ data: { items: [] } });
});
it('reads an ongoing kind annotation as participation and filters it by participation', async () => {
  const f = await fixture();
  expect(await f.annotate('kind', 'ongoing', { citations: f.cite('quiz') })).toMatchObject({ ok: true });
  // The annotation row keeps the legacy value; every read normalises it.
  expect(f.store.readAnnotations('assessment', 'a')[0]!.value).toBe('ongoing');
  expect(await f.read()).toMatchObject({ data: { fields: { kind: { value: 'participation', origin: 'agent' } },
    history: [expect.objectContaining({ value: 'participation' })] } });
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'participation' }))
    .toMatchObject({ data: { items: [expect.objectContaining({ id: 'a', kind: 'participation' })] } });
});
it('course policy text never changes the owner-only autonomy grant or its prohibited cap', async () => {
  const f = await fixture();
  await f.call('autonomy.policy.set', { courseId: 'c', status: 'prohibited' }, true);
  await f.call('autonomy.default.set', { courseId: 'c', level: 2 }, true);
  // agent-course-reading (#180): agents never annotate a course policy, and the owner's value is a policy value or null.
  expect(await f.call('annotation.record', { entity: 'course', entityId: 'c', field: 'aiPolicy', value: 'Policy from syllabus', sourceRevision: f.revision(), citations: f.cite() })).toMatchObject({ ok: false });
  expect(await f.call('annotation.owner.record', { entity: 'course', entityId: 'c', field: 'aiPolicy', value: 'Owner policy text' }, true)).toMatchObject({ ok: false });
  expect(await f.call('autonomy.check', { assessmentId: 'a', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'course-prohibited' } });
});
it('Agent item policy annotation refused: an assessment aiPolicy annotation is rejected and nothing is stored', async () => {
  const f = await fixture();
  expect(await f.annotate('aiPolicy', 'prohibited')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(f.store.readAnnotations('assessment', 'a')).toEqual([]);
  expect(f.store.loadAssessment('a')?.aiPolicy).toBeUndefined();
});
it('lists and annotation reads report the effective per-assessment policy with origin and level', async () => {
  const f = await fixture();
  f.store.saveCourse({ ...f.store.loadCourse('c')!, aiPolicy: 'allowed' });
  f.store.saveAssessment({ ...f.store.loadAssessment('a')!, aiPolicy: 'prohibited' });
  expect(await f.call('autonomy.policy.set', { courseId: 'c', assessmentId: 'b', value: 'allowed' }, true)).toMatchObject({ ok: true });
  type Page = { items: Record<string, any>[] };
  const courses = await f.call('courses.list', { limit: 100 });
  expect(courses).toMatchObject({ ok: true });
  const course = (courses as unknown as { data: Page }).data.items.find(item => item.id === 'c');
  expect(course).toMatchObject({ aiPolicy: 'allowed', policy: 'allowed', policyOrigin: 'agent', policyLevel: 'course',
    effectivePolicy: { value: 'allowed', origin: 'agent', level: 'course' } });
  const assessments = await f.call('assessments.list', { courseId: 'c', limit: 100 });
  expect(assessments).toMatchObject({ ok: true });
  const items = (assessments as unknown as { data: Page }).data.items;
  expect(items.find(item => item.id === 'a')).toMatchObject({ aiPolicy: 'prohibited', policy: 'prohibited', policyOrigin: 'agent',
    policyLevel: 'assessment', effectivePolicy: { value: 'prohibited', origin: 'agent', level: 'assessment' },
    fields: { aiPolicy: { value: 'prohibited', origin: 'agent' } } });
  expect(items.find(item => item.id === 'b')).toMatchObject({ policy: 'allowed', policyOrigin: 'owner', policyLevel: 'assessment',
    fields: { aiPolicy: { value: 'allowed', origin: 'owner' } } });
  expect(await f.read('a')).toMatchObject({ ok: true, data: { fields: { aiPolicy: { value: 'prohibited', origin: 'agent' } },
    policy: 'prohibited', policyOrigin: 'agent', policyLevel: 'assessment' } });
  expect(await f.read('b')).toMatchObject({ ok: true, data: { fields: { aiPolicy: { value: 'allowed', origin: 'owner' } },
    policy: 'allowed', policyOrigin: 'owner', policyLevel: 'assessment' } });
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
it('review 1: lists field provenance, citations, verdicts and resolvable evidence', async () => {
  const f = await fixture();
  await f.annotate();
  const id = f.store.readAnnotations('assessment', 'a')[0]!.id;
  await f.call('annotation.confirm', { entity: 'assessment', entityId: 'a', field: 'weight', annotationId: id }, true);
  expect(await f.call('assessments.list', { courseId: 'c' })).toMatchObject({ ok: true, data: {
    items: [{ id: 'a', weight: 40, fields: { weight: {
      value: 40, origin: 'agent', annotationId: id, citations: f.cite(), verdicts: [{ verdict: 'correct' }],
    } } }, expect.anything()],
    evidence: [expect.objectContaining({ sourceItemId: 'syllabus', text: expect.stringContaining('Final exam (40%)') })],
  } });
});
it('review 2: invalidates stale evidence on read while retaining marked history', async () => {
  const f = await fixture();
  await f.annotate();
  const row = f.store.readAnnotations('assessment', 'a')[0]!;
  const created = await f.call('assessment.create', { courseId: 'c', sourceRevision: f.revision(),
    name: { value: 'Final exam', citations: f.cite() }, weight: { value: 40, citations: f.cite() } });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const createdId = (created.data as { id: string }).id;
  await f.annotate('kind', 'quiz');
  await f.call('autonomy.default.set', { courseId: 'c', level: 1 }, true);
  expect(await f.call('autonomy.check', { assessmentId: 'a', action: 'fill' })).toMatchObject({ data: { decision: 'allowed' } });
  const text = 'Final exam (50%). Workshops 10%. quiz';
  f.store.saveSourceItem({ ...f.store.loadSourceItem('syllabus')!, text, contentHash: hash(text) });
  expect(await f.read()).toMatchObject({ ok: true, data: {
    fields: { weight: { value: 20, origin: 'sync', citations: [] } },
    history: [expect.objectContaining({ id: row.id, citations: [], coverage: { complete: false, gaps: [{ code: 'MISSING_EVIDENCE', reference: 'syllabus' }] } }), expect.anything()],
    coverage: { complete: false, gaps: [{ code: 'MISSING_EVIDENCE', reference: 'syllabus' }] },
  } });
  expect(f.store.readAnnotations('assessment', 'a')[0]).toEqual(row);
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'quiz' })).toMatchObject({ ok: true, data: { items: [] } });
  expect(await f.call('autonomy.check', { assessmentId: 'a', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'grant-level' } });
  expect(await f.read(createdId)).toMatchObject({ ok: true, data: { fields: {
    name: { value: null, origin: null, citations: [] }, weight: { value: null, origin: null, citations: [] },
  } } });
  expect(await f.call('sources.get', { sourceItemId: 'syllabus' })).toMatchObject({ ok: true, data: { text } });
  expect(await f.call('annotation.confirm', { entity: 'assessment', entityId: 'a', field: 'weight', annotationId: row.id }, true))
    .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
});
it('review 3: pages growing history within the byte bound without losing effective values', async () => {
  const f = await fixture();
  await f.annotate();
  const template = f.store.readAnnotations('assessment', 'a')[0]!;
  f.store.saveBatch({ annotations: Array.from({ length: 200 }, (_, index) => ({ ...template, id: `history-${index}`, value: index % 100 })) });
  expect(await f.read()).toMatchObject({ ok: true, data: { fields: { weight: { annotationId: 'history-199' } }, nextCursor: expect.any(String) } });
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await f.call('annotation.read', { entity: 'assessment', entityId: 'a', limit: 500, ...(cursor ? { cursor } : {}) });
    expect(result).toMatchObject({ ok: true, data: { fields: { weight: { value: 99, annotationId: 'history-199' } } } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
    if (!result.ok) return;
    const data = result.data as { history: { id: string }[]; nextCursor?: string };
    expect(data.history.length).toBeGreaterThan(0);
    ids.push(...data.history.map(row => row.id)); cursor = data.nextCursor;
  } while (cursor);
  expect(ids).toEqual([template.id, ...Array.from({ length: 200 }, (_, index) => `history-${index}`)]);
  expect(await f.call('annotation.confirm', { entity: 'assessment', entityId: 'a', field: 'weight', annotationId: 'history-199' }, true)).toMatchObject({ ok: true });
});

it('review 4: import keeps the platform weight independent of an agent claim that later loses evidence', async () => {
  const f = await fixture();
  // The course document is the platform value; it is re-imported as a later sync would.
  const sync = { run: () => importCourseDocument(f.store, validateCourseDocument(document([component('work', 100, [item(1, { weight: quoted(30) })], {})]),
    { final: false, now }).document!, { at: now }) };
  sync.run();
  const assessment = f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))!;
  f.store.saveSourceItem({ ...f.store.loadSourceItem('syllabus')!, courseId: assessment.courseId });
  const sourceRevision = courseEvidenceSnapshot(f.store, new TrustedStoreEvidence(f.store), assessment.courseId).sourceRevision;
  expect(await f.call('annotation.record', { entity: 'assessment', entityId: assessment.id, field: 'weight', value: 40,
    sourceRevision, citations: f.cite() })).toMatchObject({ ok: true });
  sync.run();
  expect(await f.read(assessment.id)).toMatchObject({ ok: true, data: { fields: { weight: { value: 40, origin: 'agent', citations: f.cite() } } } });
  const text = 'Revised syllabus';
  f.store.saveSourceItem({ ...f.store.loadSourceItem('syllabus')!, text, contentHash: hash(text) });
  expect(await f.read(assessment.id)).toMatchObject({ ok: true, data: { fields: { weight: { value: 30, origin: 'sync', citations: [] } } } });
  expect(f.store.loadAssessment(assessment.id)?.weight).toBe(30);
});
it('review 5: list retains missing weight evidence when kind still has valid evidence', async () => {
  const f = await fixture();
  expect(await f.annotate()).toMatchObject({ ok: true });
  expect(await f.annotate('kind', 'quiz', { citations: [{ sourceItemId: 'item-0', locator: 'item-0', quote: 'Workshop' }] })).toMatchObject({ ok: true });
  const text = 'Revised syllabus';
  f.store.saveSourceItem({ ...f.store.loadSourceItem('syllabus')!, text, contentHash: hash(text) });
  expect(await f.read()).toMatchObject({ ok: true, data: { coverage: { complete: false, gaps: [{ code: 'MISSING_EVIDENCE', reference: 'syllabus' }] } } });
  expect(await f.call('assessments.list', { courseId: 'c', kind: 'quiz' })).toMatchObject({ ok: true, data: {
    items: [expect.objectContaining({ id: 'a', kind: 'quiz', weight: 20 })],
    coverage: { complete: false, gaps: [{ code: 'MISSING_EVIDENCE', reference: 'syllabus' }] },
  } });
});
it('review 6: planner shares effective kind, name and due resolution after evidence expires', async () => {
  const f = await fixture();
  expect(await f.annotate('kind', 'exam')).toMatchObject({ ok: true });
  expect(await f.annotate('name', 'Final exam')).toMatchObject({ ok: true });
  expect(await f.annotate('due', '2026-10-20T00:00:00Z')).toMatchObject({ ok: true });
  expect(await f.call('planning.settings.set', { weekdayMinutes: [60, 60, 60, 60, 60, 0, 0],
    teachingWeekAnchor: '2026-10-19', breakWeeks: [], timeZone: 'Australia/Melbourne' }, true)).toMatchObject({ ok: true });
  const scope = { term: 'Synthetic', startDate: '2026-10-19', horizonDays: 7 };
  expect(await f.call('plan.read', scope)).toMatchObject({ ok: true, data: { deadlines: [expect.objectContaining({ workId: 'a', kind: 'exam', title: 'Final exam' })] } });
  const text = 'Revised syllabus';
  f.store.saveSourceItem({ ...f.store.loadSourceItem('syllabus')!, text, contentHash: hash(text) });
  expect(await f.read()).toMatchObject({ ok: true, data: { fields: { kind: { value: null }, name: { value: 'Synthetic assessment' }, due: { value: null } } } });
  const plan = await f.call('plan.read', scope);
  expect(plan).toMatchObject({ ok: true, data: { deadlines: [], work: expect.arrayContaining([expect.objectContaining({ workId: 'a', title: 'Synthetic assessment' })]) } });
  if (plan.ok) expect((plan.data as { work: { workId: string; due?: string }[] }).work.find(item => item.workId === 'a')?.due).toBeUndefined();
});
it('assessments.list returns points only from exactly one current linked item stating both', async () => {
  const f = await fixture();
  const platform = async () => {
    const result = await f.call('assessments.list', { courseId: 'c' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('assessments.list failed');
    return Object.fromEntries((result.data as { items: { id: string; platform?: unknown }[] }).items.map(item => [item.id, item.platform]));
  };
  const link = (assessmentId: string, sourceItemId: string) => f.store.appendAssessmentLink({ assessmentId, sourceItemId, origin: 'sync', at: '2026-01-01T00:00:00Z' });
  const facts = (id: string, points: { pointsEarned?: number; pointsPossible?: number }) =>
    f.store.saveSourceItem({ ...f.store.loadSourceItem(id)!, facts: points });
  const flags = { linked: true, submitted: false, removed: false };
  facts('item-0', { pointsEarned: 4, pointsPossible: 5 });
  link('a', 'item-0');
  expect(await platform()).toMatchObject({ a: { ...flags, pointsEarned: 4, pointsPossible: 5 } });
  // Partial facts on different items cannot be combined into a score.
  facts('item-1', { pointsEarned: 4 }); facts('item-2', { pointsPossible: 5 });
  link('b', 'item-1'); link('b', 'item-2');
  expect((await platform()).b).toEqual(flags);
  // Incomplete items do not make a single complete candidate ambiguous; zero is a stated score.
  facts('item-1', { pointsEarned: 0, pointsPossible: 5 });
  expect((await platform()).b).toEqual({ ...flags, pointsEarned: 0, pointsPossible: 5 });
  // Even equal points from two complete candidates are ambiguous.
  facts('item-2', { pointsEarned: 0, pointsPossible: 5 });
  expect((await platform()).b).toEqual(flags);
  // Moving a link removes its points from the old assessment and creates ambiguity in the new one.
  link('b', 'item-0');
  expect(await platform()).toEqual({ a: { linked: false, submitted: false, removed: false }, b: flags });
});

it('assessments.list derives platform submitted and removed flags from currently linked items only', async () => {
  const f = await fixture();
  const platform = async () => Object.fromEntries(((await f.call('assessments.list', { courseId: 'c' })) as { data: { items: { id: string; platform?: unknown }[] } })
    .data.items.map(item => [item.id, item.platform]));
  expect(await platform()).toEqual({ a: { linked: false, submitted: false, removed: false }, b: { linked: false, submitted: false, removed: false } });
  const link = (assessmentId: string, sourceItemId: string) => f.store.appendAssessmentLink({ assessmentId, sourceItemId, origin: 'sync', at: '2026-01-01T00:00:00Z' });
  link('a', 'item-0'); link('a', 'item-1'); link('b', 'item-2');
  const item = (id: string, extra: object) => ({ id, platform: 'ed' as const, externalId: id.slice(5), courseId: 'c', kind: 'assignment' as const,
    title: 'Synthetic workshop', text: 'Workshop', contentHash: hash('Workshop'), fetchedAt: '2026-01-01T00:00:00Z', ...extra });
  f.store.saveSourceItem(item('item-1', { facts: { submitted: true } }));
  f.store.saveSourceItem(item('item-2', { removed: true }));
  expect(await platform()).toEqual({ a: { linked: true, submitted: true, removed: false }, b: { linked: true, submitted: false, removed: true } });
  // A moved link no longer counts for its old assessment, matching the planner.
  link('b', 'item-1');
  expect(await platform()).toEqual({ a: { linked: true, submitted: false, removed: false }, b: { linked: true, submitted: true, removed: true } });
});

it('Owner item policy annotation points to autonomy.policy.set: an assessment aiPolicy is refused and nothing is stored', async () => {
  const f = await fixture();
  for (const value of ['prohibited', null]) {
    expect(await f.call('annotation.owner.record', { entity: 'assessment', entityId: 'a', field: 'aiPolicy', value }, true))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('autonomy.policy.set') } });
    expect(f.store.readAnnotations('assessment', 'a')).toEqual([]);
    expect(f.store.loadAssessment('a')?.aiPolicy).toBeUndefined();
  }
  // The dedicated owner command still records the policy with its audit entry.
  expect(await f.call('autonomy.policy.set', { courseId: 'c', assessmentId: 'a', value: 'prohibited' }, true)).toMatchObject({ ok: true });
  expect(await f.read()).toMatchObject({ data: { policy: 'prohibited', policyOrigin: 'owner', policyLevel: 'assessment' } });
});
