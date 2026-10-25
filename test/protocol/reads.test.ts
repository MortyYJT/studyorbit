import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { StoreProtocolReads, TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { createFakeContext, examples, FakeRepository } from '../../src/protocol/fakes.js';
import { validateCitation } from '../../src/citations/exact.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
const at = '2026-01-01T00:00:00Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function setup(text = 'Synthetic page text.') {
  const db = new SqliteRepository(':memory:');
  const course = examples['courses.list'].output.items[0];
  const source = { id: 'manual-source', courseId: course.id, platform: 'manual' as const,
    externalId: 'fixture', kind: 'material' as const, title: 'Guide', text, contentHash: 'not-a-text-hash', fetchedAt: at };
  db.saveBatch({ courses: [course], sourceItems: [source], tasks: examples['tasks.list'].output.items,
    assessments: examples['assessments.list'].output.items, runs: examples['runs.list'].output.items });
  const metadata = [{ sourceItemId: source.id, courseId: course.id, provenance: 'manual' as const,
    locator: 'page:2', page: 2, sourceHash: hash(text), legacySourceItemId: 'legacy-page' }];
  const evidence = new TrustedStoreEvidence(db, { metadata });
  const reads = new StoreProtocolReads(db, evidence, { accepted: { read: async (name, input) => {
    const value = await new FakeRepository().read(name, input);
    return 'items' in value ? { ...value, evidence: [], coverage: { complete: false, gaps: [{ code: 'MISSING_EVIDENCE' }] } } as typeof value : value;
  } } });
  return { db, reads, evidence, source, metadata, course };
}
describe('trusted protocol reads', () => {
  it('resolves legacy page aliases only through explicit verified metadata and preserves exact text hashes', async () => {
    const f = setup('  Synthetic page text.\n');
    try {
      const page = await f.reads.read('sources.get', { sourceItemId: 'legacy-page' });
      expect(page).toMatchObject({ sourceItemId: f.source.id, locator: 'page:2', page: 2, text: f.source.text, sourceHash: hash(f.source.text) });
      const materials = await f.reads.read('materials.list', { courseId: f.course.id, page: 2, limit: 1 });
      expect(materials.items).toHaveLength(1);
      expect((await f.reads.read('materials.list', { courseId: 'other', limit: 1 })).items).toEqual([]);
      expect((await f.reads.read('materials.list', { courseId: f.course.id, page: 1, limit: 1 })).items).toEqual([]);
    } finally { f.db.close(); }
  });
  it('fails closed on ambiguous identities, mismatched hashes/pages/courses and missing sources', async () => {
    const f = setup();
    try {
      for (const metadata of [[...f.metadata, ...f.metadata], [{ ...f.metadata[0], sourceHash: 'a'.repeat(64) }],
        [{ ...f.metadata[0], courseId: 'other' }], [{ ...f.metadata[0], page: 3 }],
        [{ ...f.metadata[0], provenance: 'canvas' as const }], [{ ...f.metadata[0], page: undefined }]]) {
        const provider = new TrustedStoreEvidence(f.db, { metadata });
        await expect(provider.get('legacy-page')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      }
      await expect(f.evidence.get('missing')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      const noPages = new StoreProtocolReads(f.db, new TrustedStoreEvidence(f.db));
      const page = await noPages.read('materials.list', { courseId: f.course.id, limit: 1 });
      expect(page.coverage).toMatchObject({ complete: false, gaps: [{ code: 'UNSUPPORTED' }] });
      const tasks = await f.reads.read('tasks.list', { limit: 1 });
      expect(tasks.coverage.complete).toBe(false);
      expect(tasks.coverage.gaps[0].code).toBe('MISSING_EVIDENCE');
    } finally { f.db.close(); }
  });
  it('returns stored evidence, private-looking text and URLs unchanged', async () => {
    const f = setup('Synthetic Person synthetic@example.invalid Student number: 1234567');
    try {
      expect(await f.evidence.get(f.source.id)).toMatchObject({ text: f.source.text, sourceHash: hash(f.source.text) });
      for (const text of ['Synthetic Person synthetic@example.invalid', 'password=synthetic-secret', '/Users/synthetic/private.pdf',
        'https://example.invalid/?token=synthetic-secret', 'a < b > c', 'control\u0001text']) {
        f.db.saveCourse({ ...f.course, name: text });
        expect((await f.reads.read('courses.list', { limit: 1 })).items[0].name).toBe(text);
      }
    } finally { f.db.close(); }
  });
  it.each(['revision.list', 'practice.list'] as const)('%s returns accepted records from the adapter', async name => {
    const f = setup();
    try {
      const fixture = examples[name];
      const record = fixture.output.items[0];
      const result = await f.reads.read(name, { ...fixture.input, revision: record.revision, limit: 1 });
      expect(result).toEqual({
        ...fixture.output, evidence: [],
        coverage: { complete: false, gaps: [{ code: 'MISSING_EVIDENCE' }] },
      });
      expect(result.items).toHaveLength(1);
    } finally { f.db.close(); }
  });
  it.each(['revision.list', 'practice.list'] as const)('%s reports UNSUPPORTED without an accepted-record adapter', async name => {
    const f = setup();
    try {
      const reads = new StoreProtocolReads(f.db, f.evidence);
      expect(await reads.read(name, examples[name].input)).toEqual({
        items: [], evidence: [], coverage: { complete: false, gaps: [{ code: 'UNSUPPORTED' }] },
      });
    } finally { f.db.close(); }
  });
  it('exposes recorded run measurements only and sanitizes arbitrary adapter errors', async () => {
    const f = setup();
    try {
      const run = examples['runs.list'].output.items[0];
      f.db.recordRun({ ...run, id: 'historical', pages: undefined, requests: undefined, failures: undefined, coverage: undefined });
      const runs = await f.reads.read('runs.list', { limit: 10 });
      expect(runs.items.find(r => r.id === 'historical')).not.toHaveProperty('pages');
      const accepted = { read: async () => { throw new Error('synthetic@example.invalid password=synthetic-secret'); } };
      const unsafe = new StoreProtocolReads(f.db, f.evidence, { accepted: accepted as never });
      const ctx = createFakeContext(); ctx.repository = unsafe;
      const result = await dispatch(createRegistry(), 'revision.list', { courseId: f.course.id }, ctx);
      expect(JSON.stringify(result)).not.toContain('synthetic-secret');
      expect(result.ok).toBe(false);
    } finally { f.db.close(); }
  });
});

describe('read continuation and adapter regressions', () => {
  it('keeps a filtered-out material pending page continuation and rejects changing page filters', async () => {
    const f = setup();
    try {
      const other = { ...f.source, id: 'z-source', text: 'Second page.' };
      f.db.saveSourceItem(other);
      const provider = new TrustedStoreEvidence(f.db, { metadata: [...f.metadata,
        { sourceItemId: other.id, courseId: f.course.id, provenance: 'manual', sourceHash: hash(other.text), locator: 'page 3', page: 3 }] });
      const reads = new StoreProtocolReads(f.db, provider);
      const first = await reads.read('materials.list', { courseId: f.course.id, page: 3, limit: 1 });
      expect(first.items).toEqual([]); expect(first.nextCursor).toBeDefined();
      expect((await reads.read('materials.list', { courseId: f.course.id, page: 3, limit: 1, cursor: first.nextCursor })).items[0].page).toBe(3);
      await expect(reads.read('materials.list', { courseId: f.course.id, page: 2, limit: 1, cursor: first.nextCursor }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
      f.db.saveCourse({ ...f.course, id: 'z-course' });
      const page = await reads.read('courses.list', { limit: 1 });
      // Deleting via reconciliation is out of scope; a valid cursor above the final key terminates.
      expect((await reads.read('courses.list', { limit: 1, cursor: page.nextCursor })).nextCursor).toBeUndefined();
    } finally { f.db.close(); }
  });
  it('preserves a bounded list prefix and fails on an oversized first item', async () => {
    const f = setup();
    try {
      f.db.saveCourse({ ...f.course, id: 'z-course', name: 'large '.repeat(12000) });
      const first = await f.reads.read('courses.list', { limit: 10 });
      expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeDefined();
      await expect(f.reads.read('courses.list', { limit: 10, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    } finally { f.db.close(); }
  });
  it('rejects Q1 alias collisions and resolves a current Ed question without course-name merging', async () => {
    const f = setup();
    try {
      f.db.saveSourceItem({ ...f.source, id: 'legacy-page' });
      await expect(f.evidence.get('legacy-page')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      f.db.saveSourceItem({ ...f.source, id: 'ed:7:11:2:3', platform: 'ed', kind: 'assignment', text: 'Synthetic question.' });
      expect(await f.evidence.get('ed:7:11:2:3')).toMatchObject({ courseId: f.course.id, provenance: 'ed', locator: 'ed:7:11:2:3' });
    } finally { f.db.close(); }
  });
});


it('revalidates accepted filters and keeps absent audit integration explicit', async () => {
    const f = setup();
    try {
      await expect(f.reads.read('revision.list', { courseId: 'wrong', limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      await expect(f.reads.read('practice.list', { courseId: f.course.id, week: 2, limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      expect(await f.reads.read('audit.list', { limit: 100 })).toMatchObject({ coverage: { complete: false } });
    } finally { f.db.close(); }
  });
describe('issue B review regressions', () => {
  it('P2-1 preserves numeric external IDs, UUID segments, hashes and paged run/audit reads', async () => {
    const f = setup();
    const id = '12345678-1234-4123-8123-123456789012';
    try {
      f.db.recordRun({ ...examples['runs.list'].output.items[0], id });
      const first = await f.reads.read('runs.list', { limit: 1 });
      expect(first.items[0].id).toBe(id);
      expect((await f.reads.read('runs.list', { limit: 1, cursor: first.nextCursor })).items).toHaveLength(1);
      f.db.saveSourceItem({ ...f.source, externalId: 'file:12345678' });
      expect((await f.reads.read('sources.get', { sourceItemId: f.source.id })).text).toBe(f.source.text);
      expect((await f.reads.read('materials.list', { courseId: f.course.id, limit: 1 })).coverage.complete).toBe(true);
      const reads = new StoreProtocolReads(f.db, f.evidence, { audit: { read: async () => ({
        items: [{ id, runId: id, command: 'sync', phase: 'outcome', at, code: 'OK', policyRef: '2'.repeat(64) }],
        evidence: [], coverage: { complete: true, gaps: [] } }) } });
      expect((await reads.read('audit.list', { limit: 1 })).items[0].id).toBe(id);
    } finally { f.db.close(); }
  });
});

it('returns paged evidence that the shared citation validator accepts', async () => {
  const { validateCitation } = await import('../../src/citations/exact.js');
  const f = setup('Synthetic page text.');
  try {
    const page = await f.reads.read('sources.get', { sourceItemId: f.source.id });
    const { sourceItemId, text, locator, sourceHash } = page;
    const result = validateCitation({ sourceItemId, quote: 'page text', locator }, { sourceItemId, text, locator, sourceHash, page: page.page });
    expect(result).toMatchObject({ sourceItemId: f.source.id, page: 2, sourceHash: hash('Synthetic page text.') });
  } finally { f.db.close(); }
});


it('#191 returns an assessment group containing markup characters', async () => {
  const f = setup();
  try {
    const assessment = examples['assessments.list'].output.items[0];
    const name = 'Lecture Participation = Token Streak => Flexible assessments';
    f.db.saveAssessment({ ...assessment, group: { key: 'participation', name } });
    const context = createFakeContext(); context.repository = f.reads;
    expect(await dispatch(createRegistry(), 'assessments.list', { courseId: f.course.id }, context))
      .toMatchObject({ ok: true, data: { items: [expect.objectContaining({ group: { key: 'participation', name } })] } });
  } finally { f.db.close(); }
});
