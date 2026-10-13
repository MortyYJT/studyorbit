import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { StoreProtocolReads, TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { createFakeContext, examples, FakeRepository } from '../../src/protocol/fakes.js';
import { validateCitation } from '../../src/citations/exact.js';
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
  it('redacts entity fields and URLs, returns redacted sensitive evidence and private paths', async () => {
    const f = setup('Synthetic Person synthetic@example.invalid Student number: 1234567');
    try {
      f.db.saveCourse({ ...f.course, name: 'Synthetic Person synthetic@example.invalid' });
      const courses = await f.reads.read('courses.list', { limit: 1 });
      expect(courses.items[0].name).toBe('[redacted] [redacted]');
      expect(await f.evidence.get(f.source.id)).toMatchObject({ text: '[redacted] [redacted] Student number: [redacted]', sourceHash: hash('[redacted] [redacted] Student number: [redacted]') });
      for (const text of ['password=synthetic-secret', '/Users/synthetic/private.pdf', 'https://example.invalid/?token=synthetic-secret']) {
        f.db.saveCourse({ ...f.course, name: text });
        await expect(f.reads.read('courses.list', { limit: 1 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
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
  it.each([
    'https://example.invalid/?email=synthetic@example.invalid',
    'password=synthetic-secret',
    '/Users/synthetic/private.pdf',
  ])('rejects sensitive evidence locators: %s', async locator => {
    const f = setup();
    try {
      const { page: _page, ...metadata } = f.metadata[0];
      const safeLocator = 'https://example.invalid/guide';
      const safe = new TrustedStoreEvidence(f.db, { metadata: [{ ...metadata, locator: safeLocator }] });
      expect(await safe.get(f.source.id)).toMatchObject({ locator: safeLocator });
      const unsafe = new TrustedStoreEvidence(f.db, { metadata: [{ ...metadata, locator }] });
      await expect(unsafe.get(f.source.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
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
      expect(protectRead({ externalId: 'file:12345678', id, sourceHash: '1'.repeat(64), policyRef: '2'.repeat(64) }))
        .toEqual({ externalId: 'file:12345678', id, sourceHash: '1'.repeat(64), policyRef: '2'.repeat(64) });
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
  it('P2-2 keeps safe URL syntax and returns normalized redacted evidence with exact hashes/ranges', async () => {
    const text = 'A ﬁnite example. Synthetic Person student number: 12345678';
    const f = setup(text);
    try {
      const url = 'https://canvas.example.invalid/courses/12345678/files/87654321/guide%20one.pdf?download=1';
      expect(protectRead({ url })).toEqual({ url });
      f.db.saveSourceItem({ ...f.source, externalId: 'file:12345678', title: 'ﬁnite guide', url });
      const page = await f.reads.read('sources.get', { sourceItemId: f.source.id });
      expect(page.text).toBe('A finite example. [redacted] student number: [redacted]');
      expect(page.sourceHash).toBe(hash(page.text));
      const citation = { sourceItemId: page.sourceItemId, locator: 'page:2', quote: 'finite example' };
      const accepted = validateCitation(citation, { sourceItemId: page.sourceItemId, locator: page.locator, text: page.text, sourceHash: page.sourceHash, page: 2 });
      expect(page.text.slice(accepted.offset, accepted.end)).toBe(citation.quote);
      expect((await f.reads.read('materials.list', { courseId: f.course.id, limit: 1 })).items[0]).toEqual(page);
      const safe = protectRead({ url: url + '&person=Synthetic+Person&email=synthetic%2540example.invalid&student=12345678' },
        { people: [{ name: 'Synthetic Person' }] }) as { url: string };
      expect(safe.url).toContain('/files/87654321/guide%20one.pdf');
      expect(safe.url).not.toMatch(/Synthetic|synthetic|12345678$/);
      expect(new URL(safe.url).searchParams.get('student')).toBe('[redacted]');
    } finally { f.db.close(); }
  });
  it.each([
    'https://canvas.example.invalid/files/12345678/Synthetic%20Person.pdf',
    'https://canvas.example.invalid/files/12345678/guide.pdf?name=Synthetic+Person',
    'https://canvas.example.invalid/files/12345678/guide.pdf?email=synthetic%2540example.invalid',
    'https://canvas.example.invalid/files/12345678/guide.pdf?student=12345678',
  ])('P2-2 redacts personal URL components and inline URLs idempotently: %s', url => {
    const scope = { people: [{ name: 'Synthetic Person' }] };
    const safe = protectRead({ text: `See ${url}`, url }, scope) as { text: string; url: string };
    expect(safe.url).toContain('/files/12345678/');
    expect(decodeURIComponent(safe.url)).toContain('[redacted]');
    expect(safe.text).toBe(`See ${safe.url}`);
    expect(protectRead(safe, scope)).toEqual(safe);
  });
  it('P3-1 preserves opaque cursor bytes and rejects structurally invalid identifiers/cursors', () => {
    expect(protectRead({ nextCursor: '12345678-cursor' })).toEqual({ nextCursor: '12345678-cursor' });
    for (const value of [{ nextCursor: 'bad cursor' }, { sourceHash: 'invalid' }, { id: '' }]) expect(() => protectRead(value)).toThrow();
    for (const id of ['synthetic@example.invalid', 'Synthetic Person', '/tmp/private'])
      expect(() => protectRead({ id }, { people: [{ name: 'Synthetic Person' }] })).toThrow();
  });
});

it('redacts harvested personal numeric identities even in numeric URL path segments', () => {
  const scope = { people: [{ name: 'Synthetic Person', student_number: '12345678' }] };
  const safe = protectRead({ url: 'https://example.invalid/students/12345678/files/87654321' }, scope) as { url: string };
  expect(decodeURIComponent(safe.url)).toBe('https://example.invalid/students/[redacted]/files/87654321');
});

it('preserves decision #81 untagged six/seven-digit math and redacts labelled or harvested identities', () => {
  expect(protectRead({ text: 'Values 123456 and 1234567; student id: 7654321' }))
    .toEqual({ text: 'Values 123456 and 1234567; student id: [redacted]' });
  expect(protectRead({ text: 'Value 1234567' }, { people: [{ student_id: '1234567' }] }))
    .toEqual({ text: 'Value [redacted]' });
});

it.each(['student', 'student_id', 'studentNumber', 'name'])('redacts explicitly personal URL query %s even with short values', key => {
  const safe = protectRead({ url: `https://example.invalid/files/1234567?${key}=1234567` }) as { url: string };
  expect(new URL(safe.url).pathname).toBe('/files/1234567');
  expect(new URL(safe.url).searchParams.get(key)).toBe('[redacted]');
});

it.each(['synthetic%40example.invalid', 'Synthetic%20Person', '%2Ftmp%2Fprivate', 'student%20id%3A1234567'])
('rejects encoded sensitive identifiers without rewriting them: %s', id => {
  expect(() => protectRead({ id }, { people: [{ name: 'Synthetic Person' }] })).toThrow();
});

it('does not mistake a numeric hash substring for a harvested student identity', () => {
  const value = { sourceHash: '1'.repeat(64), policyRef: '1'.repeat(64) };
  expect(protectRead(value, { people: [{ student_id: '11111111' }] })).toEqual(value);
});

it('withholds personal Unicode hostnames rather than returning the original unsafe authority', () => {
  expect(() => protectRead({ url: 'https://同学甲.example.invalid/files/12345678' },
    { people: [{ name: '同学甲' }] })).toThrow();
});

it.each(['Bearer synthetic-secret', 'Bearer%20synthetic-secret', 'x-token', 'authTokenValue', 'authorizationValue'])
('withholds credential syntax in structurally valid identifiers: %s', id => {
  expect(() => protectRead({ id })).toThrow();
});

it('keeps valid M1 content hashes unchanged even when digits overlap harvested identities', () => {
  const value = { contentHash: '1'.repeat(64) };
  expect(protectRead(value, { people: [{ student_id: '11111111' }] })).toEqual(value);
});

it.each(['student number', 'student-id', 'student_no', 'author_name', 'phone_number'])
('redacts aliased personal query labels without damaging provider paths: %s', key => {
  const url = `https://example.invalid/files/1234567?${encodeURIComponent(key)}=1234567`;
  const safe = protectRead({ url }) as { url: string };
  expect(new URL(safe.url).pathname).toBe('/files/1234567');
  expect(new URL(safe.url).searchParams.get(key)).toBe('[redacted]');
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
