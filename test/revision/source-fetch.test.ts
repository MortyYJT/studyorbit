import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceFetcher } from '../../src/revision/source-fetch.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { StudyWriteService, InMemoryStudyRecordStore } from '../../src/protocol/study-writes.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { hash } from '../../src/citations/exact.js';

/** Build a small real PDF without a fixture file or an additional dependency. */
export function pdf(pages: string[]): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const text of pages) {
    const content = text ? `BT /F1 12 Tf 40 700 Td (${text}) Tj ET` : 'q 20 0 0 20 40 700 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /ASCIIHexDecode ID FF0000> EI Q';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new Uint8Array(Buffer.from(body));
}
const roots: string[] = []; const stores: SqliteRepository[] = [];
afterEach(async () => { stores.splice(0).forEach(s => s.close()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const url = 'https://canvas.lms.unimelb.edu.au/courses/1/files/2/download';
async function setup(body: Uint8Array, type = 'application/pdf') {
  const root = await mkdtemp(join(tmpdir(), 'revision-source-')); roots.push(root);
  const store = new SqliteRepository(join(root, 'data.db')); stores.push(store);
  store.saveCourse({ id: 'c', moduleId: 'm', code: 'SYN', name: 'Synthetic', term: 'test', assessmentsComplete: true, sources: [{ platform: 'canvas', externalId: '1' }, { platform: 'ed', externalId: '1' }] });
  const read = vi.fn(async () => ({ url, status: 200, contentType: type, body }));
  const fetcher = new SourceFetcher({ store, directory: root, transport: { read } });
  return { root, store, read, fetcher };
}
it('stores PDF pages, validates a page-2 note, survives reopen and keeps raw bytes private', async () => {
  const bytes = pdf(['Synthetic first page.', 'Recursion needs a base case.', 'Synthetic third page.']);
  const { root, store, fetcher } = await setup(bytes);
  const result = await fetcher.fetch({ courseId: 'c', url });
  expect(result.items.map(item => item.page)).toEqual([1, 2, 3]);
  expect(store.query('sourceItems', { courseId: 'c', limit: 100 }).items).toHaveLength(3);
  const page = result.items[1]!;
  const provider = { resolve: async () => ({ target: { courseId: 'c' }, sourceRevision: result.sourceRevision, sources: result.items }) };
  const service = new StudyWriteService({ provider, store: new InMemoryStudyRecordStore() });
  expect(await service.write('revision.write', { courseId: 'c', sourceRevision: result.sourceRevision,
    claims: [{ text: 'Use a base case.', citations: [{ sourceItemId: page.sourceItemId, quote: 'Recursion needs a base case.', locator: 'page:2' }] }] }, createFakeContext())).toHaveProperty('revision');
  const raw = join(root, 'materials', `${hash(url)}.raw`);
  expect((await stat(join(root, 'materials'))).mode & 0o777).toBe(0o700);
  expect((await stat(raw)).mode & 0o777).toBe(0o600);
  expect(await readFile(raw)).toEqual(Buffer.from(bytes));
  store.close(); const reopened = new SqliteRepository(join(root, 'data.db')); stores.push(reopened);
  expect(await new TrustedStoreEvidence(reopened).get(page.sourceItemId)).toEqual(page);
});
it.each([
  ['Ed thread', 'https://edstem.org/au/courses/1/discussion/2'],
  ['Ed API thread', 'https://edstem.org/api/threads/2'],
  ['Canvas discussion', 'https://canvas.lms.unimelb.edu.au/api/v1/courses/1/discussion_topics/2'],
  ['encoded discussion', 'https://canvas.lms.unimelb.edu.au/courses/1/%64iscussion_topics/2'],
  ['off-origin', 'https://example.org/file.pdf'],
])('refuses %s before fetching or storing', async (_name, target) => {
  const { fetcher, read, store } = await setup(pdf(['Synthetic']));
  await expect(fetcher.fetch({ courseId: 'c', url: target })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(read).not.toHaveBeenCalled(); expect(store.query('sourceItems', { limit: 100 }).items).toEqual([]);
});
it('refuses redirects, non-GET input, oversized responses and missing courses without publication', async () => {
  const { fetcher, read, store } = await setup(pdf(['Synthetic']));
  read.mockResolvedValueOnce({ url: 'https://example.org/file', status: 302, contentType: 'application/pdf', body: pdf(['Synthetic']) });
  await expect(fetcher.fetch({ courseId: 'c', url })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await expect(fetcher.fetch({ courseId: 'c', url, method: 'POST' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(fetcher.fetch({ courseId: 'missing', url })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  read.mockResolvedValueOnce({ url, status: 200, contentType: 'application/pdf', body: new Uint8Array(10 * 1024 * 1024 + 1) });
  await expect(fetcher.fetch({ courseId: 'c', url })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(store.query('sourceItems', { limit: 100 }).items).toEqual([]);
});
it('redacts JSON author identities and personal data before source storage', async () => {
  const body = { author: { name: 'Fictional Peer' }, title: 'Synthetic page', body: 'Fictional Peer uses synthetic@example.org. student id: 1234567' };
  const { fetcher, store } = await setup(new Uint8Array(Buffer.from(JSON.stringify(body))), 'application/json');
  const result = await fetcher.fetch({ courseId: 'c', url });
  expect(result.items[0]!.text).toContain('[redacted]');
  expect(JSON.stringify(store.query('sourceItems', { limit: 100 }).items)).not.toMatch(/Fictional Peer|synthetic@example.org|1234567/);
});
it('reports image-only pages as empty sources, never guessed evidence', async () => {
  const { fetcher, store } = await setup(pdf(['Synthetic', '']));
  const result = await fetcher.fetch({ courseId: 'c', url });
  expect(result.emptyPages).toEqual([2]);
  expect(store.query('sourceItems', { limit: 100 }).items.find(item => item.text === '')).toBeDefined();
  expect(result.items).toHaveLength(1);
});
it('rejects private source text before publishing any material', async () => {
  const { fetcher, store } = await setup(new Uint8Array(Buffer.from('Read /home/fictional/private-material.txt')), 'text/plain');
  await expect(fetcher.fetch({ courseId: 'c', url })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  expect(store.query('sourceItems', { limit: 100 }).items).toEqual([]);
});

it('uses harvested HTML author identities to redact visible mentions', async () => {
  const { root, store } = await setup(new Uint8Array(), 'text/html');
  const fetcher = new SourceFetcher({ store, directory: root, transport: { read: async () => ({ url, status: 200, contentType: 'text/html', body: new Uint8Array(Buffer.from('<p>Synthetic</p>')), text: 'Fictional Peer discussed recursion.', privacyScope: { authors: [{ name: 'Fictional Peer' }] } }) } });
  const result = await fetcher.fetch({ courseId: 'c', url });
  expect(result.items[0]!.text).toBe('[redacted] discussed recursion.');
  expect(JSON.stringify(store.query('sourceItems', { limit: 100 }).items)).not.toContain('Fictional Peer');
});
it('retains browser-harvested author scope when the response is JSON containing HTML', async () => {
  const { root, store } = await setup(new Uint8Array(), 'application/json');
  const fetcher = new SourceFetcher({ store, directory: root, transport: { read: async () => ({ url, status: 200, contentType: 'application/json', body: new Uint8Array(Buffer.from(JSON.stringify({ body: '<span class="author">Fictional Peer</span><p>Fictional Peer discussed recursion.</p>' }))), text: 'Fictional Peer discussed recursion.', privacyScope: { authors: [{ name: 'Fictional Peer' }] } }) } });
  expect((await fetcher.fetch({ courseId: 'c', url })).items[0]!.text).toBe('[redacted] discussed recursion.');
});

it('rejects another course and unscoped provider URLs before reading or storing', async () => {
  const { fetcher, read, store } = await setup(pdf(['Synthetic']));
  for (const target of ['https://canvas.lms.unimelb.edu.au/courses/2/pages/lecture',
    'https://edstem.org/au/courses/2/lessons/1', 'https://canvas.lms.unimelb.edu.au/files/2/download']) {
    await expect(fetcher.fetch({ courseId: 'c', url: target })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(read).not.toHaveBeenCalled();
  expect(store.query('sourceItems', { limit: 100 }).items).toEqual([]);
});
it('fetches lecture pages and files with thread words while refusing discussion routes', async () => {
  const { fetcher, read } = await setup(new Uint8Array(Buffer.from('Synthetic lecture')), 'text/plain');
  for (const target of ['https://canvas.lms.unimelb.edu.au/courses/1/pages/multithreading',
    'https://canvas.lms.unimelb.edu.au/courses/1/files/lecture-threads.pdf',
    'https://canvas.lms.unimelb.edu.au/courses/1/pages/threads']) {
    read.mockResolvedValueOnce({ url: target, status: 200, contentType: 'text/plain', body: new Uint8Array(Buffer.from('Synthetic lecture')) });
    expect((await fetcher.fetch({ courseId: 'c', url: target })).items[0]!.text).toBe('Synthetic lecture');
  }
  for (const route of ['discussion_topics/2', 'threads/2', 'replies/2', '%2564iscussion_topics/2']) {
    await expect(fetcher.fetch({ courseId: 'c', url: `https://canvas.lms.unimelb.edu.au/courses/1/${route}` })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(read).toHaveBeenCalledTimes(3);
});

it('fetches unscoped Ed APIs only for an active same-course stored source URL', async () => {
  const { fetcher, read, store } = await setup(new Uint8Array(Buffer.from('Synthetic lesson')), 'text/plain');
  store.saveCourse({ id: 'other', moduleId: 'm', code: 'OTHER', name: 'Other', term: 'test', assessmentsComplete: true, sources: [{ platform: 'ed', externalId: '2' }] });
  // Exercise mapping lookup past the first repository page.
  for (let i = 0; i < 501; i++) store.saveSourceItem({ id: `a-${i}`, externalId: `${i}`, courseId: 'c', platform: 'ed', kind: 'material', title: 'Synthetic', text: '', contentHash: hash(''), fetchedAt: '2026-01-01T00:00:00Z' });
  for (const [i, path] of ['/api/lessons/10', '/api/lessons/slides/20'].entries()) {
    const target = `https://edstem.org${path}`;
    store.saveSourceItem({ id: `z-${i}`, externalId: `${i}`, courseId: 'c', platform: 'ed', kind: 'material', title: 'Synthetic', url: target, text: '', contentHash: hash(''), fetchedAt: '2026-01-01T00:00:00Z' });
    await expect(fetcher.fetch({ courseId: 'other', url: target })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(read).toHaveBeenCalledTimes(i);
    read.mockResolvedValueOnce({ url: target, status: 200, contentType: 'text/plain', body: new Uint8Array(Buffer.from('Synthetic lesson')) });
    expect((await fetcher.fetch({ courseId: 'c', url: target })).items[0]!.text).toBe('Synthetic lesson');
  }
  for (const [id, removed, platform] of [['removed', true, 'ed'], ['wrong-platform', false, 'canvas']] as const) {
    const target = `https://edstem.org/api/lessons/${id}`;
    store.saveSourceItem({ id, externalId: id, courseId: 'c', platform, kind: 'material', title: 'Synthetic', url: target, removed, text: '', contentHash: hash(''), fetchedAt: '2026-01-01T00:00:00Z' });
    await expect(fetcher.fetch({ courseId: 'c', url: target })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  await expect(fetcher.fetch({ courseId: 'c', url: 'https://edstem.org/api/lessons/99' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(read).toHaveBeenCalledTimes(2);
});
