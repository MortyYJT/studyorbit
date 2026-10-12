import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { StoreProtocolReads, TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { createFakeContext, examples, FakeRepository } from '../../src/protocol/fakes.js';
import { protectRead } from '../../src/protocol/read-privacy.js';
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
  const evidence = new TrustedStoreEvidence(db, { metadata, privacyScope: { people: [{ name: 'Synthetic Person' }] } });
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
      expect(page).toMatchObject({ sourceItemId: f.source.id, locator: 'page 2', page: 2, text: f.source.text, sourceHash: hash(f.source.text) });
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
        [{ ...f.metadata[0], courseId: 'other' }], [{ ...f.metadata[0], page: 3 }]]) {
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
  it('uses accepted-record ports and reports absent adapters without invented records', async () => {
    const f = setup();
    try {
      for (const name of ['revision.list', 'practice.list'] as const) {
        const value = await f.reads.read(name, { courseId: f.course.id, limit: 1 });
        expect(value.items).toHaveLength(1);
        const missing = new StoreProtocolReads(f.db, f.evidence);
        expect((await missing.read(name, { courseId: f.course.id, limit: 1 })).coverage.gaps).toEqual([{ code: 'UNSUPPORTED' }]);
      }
      await expect(new StoreProtocolReads(f.db, f.evidence).read('proposals.get', { assessmentId: 'unknown' }))
        .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    } finally { f.db.close(); }
  });
  it('redacts entity fields and URLs, withholds stale sensitive evidence and private paths', async () => {
    const f = setup('Synthetic Person synthetic@example.invalid Student number: 1234567');
    try {
      f.db.saveCourse({ ...f.course, name: 'Synthetic Person synthetic@example.invalid' });
      const courses = await f.reads.read('courses.list', { limit: 1 });
      expect(courses.items[0].name).toBe('[redacted] [redacted]');
      await expect(f.evidence.get(f.source.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      for (const text of ['password=synthetic-secret', '/Users/synthetic/private.pdf', 'https://example.invalid/?token=synthetic-secret']) {
        f.db.saveCourse({ ...f.course, name: text });
        await expect(f.reads.read('courses.list', { limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      }
    } finally { f.db.close(); }
  });
  it('mounts exclusive changes and never advances past oversized or unsafe events', async () => {
    const f = setup();
    try {
      f.db.recordChange({ kind: 'created', entity: 'course', entityId: 'one', at, after: { name: 'Synthetic Person', url: 'https://example.invalid/?email=synthetic%40example.invalid' } });
      f.db.recordChange({ kind: 'created', entity: 'course', entityId: 'two', at, after: { text: 'large '.repeat(12000) } });
      const ctx = createFakeContext(); ctx.repository = f.reads;
      const result = await dispatch(createRegistry(), 'changes', { since: 0 }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toMatchObject({ nextCursor: 1, changes: [{ after: { name: '[redacted]' } }] });
      await expect(f.reads.read('changes', { since: 1, limit: 100 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      expect(await f.reads.read('changes', { since: 2, limit: 100 })).toEqual({ changes: [], nextCursor: 2 });
      f.db.recordChange({ kind: 'created', entity: 'course', entityId: 'three', at, after: { text: 'password=synthetic-secret' } });
      await expect(f.reads.read('changes', { since: 2, limit: 100 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
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
  it('revalidates accepted filters and keeps absent quiz/audit integration explicit', async () => {
    const f = setup();
    try {
      await expect(f.reads.read('revision.list', { courseId: 'wrong', limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      await expect(f.reads.read('practice.list', { courseId: f.course.id, week: 2, limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      expect(await f.reads.read('proposals.get', examples['proposals.get'].input)).toEqual(examples['proposals.get'].output);
      await expect(f.reads.read('proposals.get', { assessmentId: 'wrong' })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      expect((await f.reads.read('audit.list', { limit: 1 })).coverage.gaps).toEqual([{ code: 'UNSUPPORTED' }]);
      await expect(f.reads.read('quiz.read', { course: '7', lesson: '11' })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      const expired = new StoreProtocolReads(f.db, f.evidence, { quiz: { read: async () => { const { CourseworkError } = await import('../../src/protocol/errors.js'); throw new CourseworkError('AUTH_EXPIRED', 'password=synthetic-secret'); } } });
      const ctx = createFakeContext(); ctx.repository = expired;
      const result = await dispatch(createRegistry(), 'quiz.read', { course: '7', lesson: '11' }, ctx);
      expect(result).toMatchObject({ ok: false, error: { code: 'AUTH_EXPIRED' } });
      expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    } finally { f.db.close(); }
  });
  it('withholds sensitive locators, hidden solutions and unknown student snapshots', async () => {
    const f = setup();
    try {
      for (const locator of ['https://example.invalid/?email=synthetic%40example.invalid', 'password=synthetic-secret', '/tmp/private.pdf']) {
        const provider = new TrustedStoreEvidence(f.db, { metadata: [{ ...f.metadata[0], page: undefined, locator }] });
        await expect(provider.get(f.source.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      }
      for (const after of [{ hidden_solution: 'Synthetic hidden answer' }, { author: { name: 'Synthetic Person', answer: 'Other answer' } }]) {
        const change = f.db.recordChange({ entity: 'source_item', entityId: f.source.id, kind: 'created', at, after });
        await expect(f.reads.read('changes', { since: change.seq - 1, limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      }
    } finally { f.db.close(); }
  });
});


describe('independent review privacy regressions', () => {
  it('withholds paths after NFKC and URL decoding and in query assignments', () => {
    for (const text of ['／Users/synthetic/private.pdf', 'https://example.invalid/?path=%2FUsers%2Fsynthetic%2Fprivate.pdf',
      'path=/Users/synthetic/private.pdf', 'https://example.invalid/?path=%252Ftmp%252Fprivate.pdf']) {
      expect(() => protectRead({ text })).toThrow();
    }
  });
  it('withholds flat person snapshots together with their answers and grades', () => {
    for (const key of ['student_name', 'author_name', 'created_by_name', 'student_number']) {
      expect(() => protectRead({ after: { [key]: 'Synthetic Person', grade: 'A', answer: 'Synthetic other answer' } })).toThrow();
    }
    expect(protectRead({ answer: 'Synthetic practice answer', prompt: 'Practice' })).toEqual({ answer: 'Synthetic practice answer', prompt: 'Practice' });
  });
});


it('keeps legacy size failure for an event above redactor input bounds', async () => {
  const f = setup();
  try {
    f.db.recordChange({ kind: 'created', entity: 'source_item', entityId: 'huge', at, after: { text: 'large '.repeat(170000) } });
    await expect(f.reads.read('changes', { since: 0, limit: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  } finally { f.db.close(); }
});
