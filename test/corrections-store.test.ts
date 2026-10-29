import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCorrectionsHandler, createCorrectionsStore } from '../scripts/lib/corrections-store.mjs';
import { conflictId, type CorrectionsView } from '../shared/corrections.js';

type Imported = { imported: true; store: CorrectionsView };
import type { CourseDocument, CourseDocumentV1, CourseDocumentV2 } from '../shared/course-data.js';

// Scenarios from openspec/changes/local-corrections-merge/specs/local-corrections/spec.md (PR 1). Synthetic data only.
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'corrections-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const item = (id: string, patch: Partial<CourseDocumentV1['assessments'][number]> = {}): CourseDocumentV1['assessments'][number] => ({
  id, name: `Synthetic ${id}`, kind: 'assignment', nature: 'regular', parentId: null, weight: 20, score: null, maxScore: null,
  due: '2026-11-10T12:59:00Z', status: 'not_started', scoring: 'none', rule: null, sources: [], ...patch,
});
const v1Doc = (assessments = [item('a1'), item('a2')]): CourseDocumentV1 => ({
  version: 1, course: { id: '100', code: 'SYNT10001', name: 'Synthetic Course', term: null }, assessments, materials: [],
});
const v2Doc = (): CourseDocumentV2 => ({
  version: 2, course: { id: '100', code: 'SYNT10001', name: 'Synthetic Course', term: null }, materials: [], legacyIds: { a1: 'canvas:5551' },
  assessments: [
    { ...item('canvas-group:300', { name: 'Quizzes', weight: 30, scoring: 'points' }), refs: [], weightQuote: null, ruleQuote: null, unsourced: [] },
    { ...item('canvas:5551', { parentId: 'canvas-group:300', weight: null }), refs: [], weightQuote: null, ruleQuote: null, unsourced: [] },
  ],
});
const digest = (doc: CourseDocument) => createHash('sha256').update(JSON.stringify(doc)).digest('hex');
const file = (courseId = '100') => join(dir, '.local', 'corrections', `${courseId}.json`);
const readJson = async (courseId = '100') => JSON.parse(await readFile(file(courseId), 'utf8'));
const empty = { corrections: {}, manual: [], order: [] };

function storeWith(documents: Record<string, CourseDocument | null> = {}) {
  return createCorrectionsStore({ projectDir: dir, loadDocument: async (courseId: string) => documents[courseId] ?? null, now: () => new Date('2026-10-30T01:00:00.000Z') });
}

describe('corrections store files', () => {
  it('reads a missing file as no store and lists nothing', async () => {
    const store = storeWith();
    expect(await store.read('100')).toEqual({ exists: false, revision: 0, corrections: {}, manual: [], order: [], conflicts: [] });
    expect(await store.list()).toEqual({ courses: {} });
  });

  it('rejects an invalid course ID and touches nothing', async () => {
    const store = storeWith();
    await expect(store.read('../x')).rejects.toThrow('INVALID_COURSE_ID');
    await expect(store.save('../x', { ...empty, revision: 0 })).rejects.toThrow('INVALID_COURSE_ID');
    await expect(store.importCourse('../x', empty)).rejects.toThrow('INVALID_COURSE_ID');
    await expect(stat(join(dir, '.local'))).rejects.toThrow();
  });

  it('writes a 0600 file in a 0700 directory atomically and bumps the revision by one', async () => {
    const store = storeWith({ 100: v1Doc() });
    const first = await store.save('100', { revision: 0, corrections: { '100:a1': { weight: 25 } }, manual: [], order: ['100:a2', '100:a1'] });
    expect(first).toEqual({ exists: true, revision: 1, corrections: { '100:a1': { weight: 25 } }, manual: [], order: ['100:a2', '100:a1'], conflicts: [] });
    const second = await store.save('100', { revision: 1, corrections: { '100:a1': { weight: 30 } }, manual: [{ key: '100:manual:m1', name: 'Synthetic manual', weight: '5%' }], order: [] });
    expect(second.revision).toBe(2);
    expect(second.manual).toEqual([{ key: '100:manual:m1', name: 'Synthetic manual', weight: '5%' }]);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, '.local', 'corrections'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(dir, '.local', 'corrections'))).toEqual(['100.json']);
    expect(await readJson()).toMatchObject({ version: 1, courseId: '100', revision: 2, base: { digest: digest(v1Doc()) }, updatedAt: '2026-10-30T01:00:00.000Z' });
    expect(await store.list()).toEqual({ courses: { 100: second } });
  });

  it('serialises concurrent saves in call order', async () => {
    const store = storeWith({ 100: v1Doc() });
    const results = await Promise.all([0, 1, 2, 3, 4].map(revision => store.save('100', { revision, corrections: { '100:a1': { weight: 21 + revision } }, manual: [], order: [] })));
    expect(results.map(view => view.revision)).toEqual([1, 2, 3, 4, 5]);
    expect((await readJson()).corrections).toEqual({ '100:a1': { weight: 25 } });
  });

  it('rejects a stale revision with the current store and leaves the file alone', async () => {
    const store = storeWith({ 100: v1Doc() });
    await store.save('100', { revision: 0, corrections: { '100:a1': { weight: 25 } }, manual: [], order: [] });
    const current = await store.save('100', { revision: 1, corrections: { '100:a1': { weight: 26 } }, manual: [], order: [] });
    const before = await readFile(file(), 'utf8');
    const error = await store.save('100', { revision: 1, corrections: { '100:a1': { weight: 99 } }, manual: [], order: [] }).catch(caught => caught);
    expect(error.message).toBe('REVISION_MISMATCH');
    expect(error.current).toEqual(current);
    expect(await readFile(file(), 'utf8')).toBe(before);
    // A save that expects an existing store when there is none is stale too.
    const missing = await store.save('200', { revision: 3, ...empty }).catch(caught => caught);
    expect(missing.message).toBe('REVISION_MISMATCH');
    expect(missing.current).toEqual({ exists: false, revision: 0, corrections: {}, manual: [], order: [], conflicts: [] });
  });

  for (const [label, content] of [['invalid JSON', '{ not json'], ['a schema failure', JSON.stringify({ version: 1, courseId: '100' })], ['an unknown version', JSON.stringify({ version: 2 })]] as const) {
    it(`refuses to overwrite a file with ${label}`, async () => {
      await mkdir(join(dir, '.local', 'corrections'), { recursive: true });
      await writeFile(file(), content);
      await writeFile(file('200'), JSON.stringify({ version: 1 }));
      const store = storeWith({ 100: v1Doc() });
      await expect(store.read('100')).rejects.toThrow('CORRECTIONS_UNREADABLE');
      await expect(store.save('100', { revision: 0, ...empty })).rejects.toThrow('CORRECTIONS_UNREADABLE');
      await expect(store.save('100', { revision: 1, ...empty })).rejects.toThrow('CORRECTIONS_UNREADABLE');
      await expect(store.importCourse('100', { corrections: { '100:a1': { weight: 1 } }, manual: [], order: [] })).rejects.toThrow('CORRECTIONS_UNREADABLE');
      expect(await readFile(file(), 'utf8')).toBe(content);
      expect(await store.list()).toEqual({ courses: { 100: { error: 'CORRECTIONS_UNREADABLE' }, 200: { error: 'CORRECTIONS_UNREADABLE' } } });
    });
  }

  it('refuses a store file that belongs to another course', async () => {
    const store = storeWith({ 100: v1Doc() });
    await store.save('100', { revision: 0, corrections: { '100:a1': { weight: 25 } }, manual: [], order: [] });
    await writeFile(file('300'), await readFile(file(), 'utf8'));
    await expect(store.read('300')).rejects.toThrow('CORRECTIONS_UNREADABLE');
  });
});

describe('first save and import', () => {
  it('first save keeps a correction only when it differs from the newest course file', async () => {
    const store = storeWith({ 300: { ...v1Doc(), course: { id: '300', code: 'SYNT30001', name: 'Synthetic Three', term: null } } });
    const view = await store.save('300', { revision: 0, corrections: { '300:a1': { weight: 20, name: 'Synthetic a1' }, '300:a2': { weight: 35, status: '' } }, manual: [], order: [] });
    expect(view.corrections).toEqual({ '300:a2': { weight: 35 } });
  });

  it('imports with the newest file as base: keys moved, group due null dropped, fields equal to the base removed, conflicts recorded', async () => {
    const store = storeWith({ 100: v2Doc() });
    const result = (await store.importCourse('100', {
      corrections: {
        '100:a1': { weight: 15, name: 'Synthetic canvas:5551', status: '' },
        '100:group:100:canvas-group:300': { due: null, name: 'All quizzes', weight: 30 },
        '100:a9': { weight: 5 },
        '100:canvas-group:300': { mergeInto: '100:a8' },
        '100:a7': { hidden: true },
      },
      manual: [{ key: '100:manual:m1', name: 'Synthetic manual', parent: '100:a1' }],
      order: ['100:a1', '100:canvas:5551', '100:group:100:canvas-group:300'],
    })) as Imported;
    expect(result.imported).toBe(true);
    expect(result.store.corrections).toEqual({
      '100:canvas:5551': { weight: 15 },
      '100:group:100:canvas-group:300': { name: 'All quizzes' },
      '100:a9': { weight: 5 },
      '100:canvas-group:300': { mergeInto: '100:a8' },
      '100:a7': { hidden: true },
    });
    expect(result.store.manual).toEqual([{ key: '100:manual:m1', name: 'Synthetic manual', parent: '100:canvas:5551' }]);
    expect(result.store.order).toEqual(['100:canvas:5551', '100:group:100:canvas-group:300']);
    expect(result.store.conflicts.map((conflict: { type: string; key: string; field: string | null }) => [conflict.type, conflict.key, conflict.field])).toEqual([
      ['orphaned', '100:a9', null], ['dangling', '100:canvas-group:300', 'mergeInto'],
    ]);
    expect(result.store.conflicts[0]).toMatchObject({ id: conflictId('orphaned', '100:a9', null), detectedAt: '2026-10-30T01:00:00.000Z' });
    const saved = await readJson();
    expect(saved.base.digest).toBe(digest(v2Doc()));
    expect(Object.keys(saved.base.assessments)).toEqual(['canvas-group:300', 'canvas:5551']);
    expect(saved.revision).toBe(1);
  });

  it('a second import answers imported: false and changes nothing', async () => {
    const store = storeWith({ 100: v1Doc() });
    expect((await store.importCourse('100', { corrections: { '100:a1': { weight: 30 } }, manual: [], order: [] })).imported).toBe(true);
    const before = await readFile(file(), 'utf8');
    expect(await store.importCourse('100', { corrections: { '100:a1': { weight: 99 } }, manual: [], order: [] })).toEqual({ imported: false });
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('two imports at once create the store once', async () => {
    const store = storeWith({ 100: v1Doc() });
    const results = await Promise.all([1, 2].map(weight => store.importCourse('100', { corrections: { '100:a1': { weight } }, manual: [], order: [] })));
    expect(results.map(result => result.imported).sort()).toEqual([false, true]);
    expect((await readJson()).corrections).toEqual({ '100:a1': { weight: 1 } });
  });

  it('without a course file the base is empty with no digest and nothing is flagged', async () => {
    const store = storeWith();
    const result = (await store.importCourse('100', { corrections: { '100:a1': { weight: 20, status: '' }, '100:a2': { parent: '100:a9' } }, manual: [], order: [] })) as Imported;
    expect(result.store.corrections).toEqual({ '100:a1': { weight: 20 }, '100:a2': { parent: '100:a9' } });
    expect(result.store.conflicts).toEqual([]);
    expect((await readJson()).base).toEqual({ digest: null, assessments: {} });
  });

  it('rejects an invalid body and a failing course document without writing', async () => {
    const store = storeWith();
    await expect(store.importCourse('100', { corrections: { '100:a1': { colour: 'red' } }, manual: [], order: [] })).rejects.toThrow('INVALID_BODY');
    const failing = createCorrectionsStore({ projectDir: dir, loadDocument: async () => { throw new Error('disk'); } });
    await expect(failing.importCourse('100', empty)).rejects.toThrow('CORRECTIONS_UNAVAILABLE');
    await expect(stat(file())).rejects.toThrow();
  });
});

describe('corrections HTTP handler', () => {
  let server: Server;
  let origin: string;
  beforeEach(async () => {
    const handle = createCorrectionsHandler(storeWith({ 100: v1Doc() }));
    server = createServer((req, res) => {
      // Mounted like Vite's connect middleware: the prefix is stripped from req.url.
      if (!req.url?.startsWith('/api/local/corrections')) { res.writeHead(404).end(); return; }
      req.url = req.url.slice('/api/local/corrections'.length) || '/';
      void handle(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const send = (path: string, init: RequestInit & { json?: unknown } = {}) => fetch(`${origin}/api/local/corrections${path}`, {
    ...init, headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });

  it('imports, reads one and all, and saves with revisions', async () => {
    const imported = await send('/100/import', { method: 'POST', json: { corrections: { '100:a1': { weight: 30 } }, manual: [], order: [] } });
    expect(imported.status).toBe(201);
    expect(imported.headers.get('cache-control')).toBe('no-store');
    expect((await imported.json()).store.revision).toBe(1);
    const again = await send('/100/import', { method: 'POST', json: empty });
    expect([again.status, await again.json()]).toEqual([200, { imported: false }]);
    expect(await (await fetch(`${origin}/api/local/corrections?courseId=100`)).json()).toMatchObject({ exists: true, revision: 1, corrections: { '100:a1': { weight: 30 } } });
    expect(await (await fetch(`${origin}/api/local/corrections?courseId=200`)).json()).toEqual({ exists: false, revision: 0, corrections: {}, manual: [], order: [], conflicts: [] });
    expect(Object.keys((await (await fetch(`${origin}/api/local/corrections`)).json()).courses)).toEqual(['100']);
    const saved = await send('/100', { method: 'PUT', json: { revision: 1, corrections: { '100:a1': { weight: 31 } }, manual: [], order: [] } });
    expect([saved.status, (await saved.json()).revision]).toEqual([200, 2]);
    const stale = await send('/100', { method: 'PUT', json: { revision: 1, corrections: {}, manual: [], order: [] } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'REVISION_MISMATCH', current: { revision: 2, corrections: { '100:a1': { weight: 31 } } } });
  });

  it('refuses foreign origins, missing JSON content type and other methods', async () => {
    expect((await fetch(`${origin}/api/local/corrections`, { headers: { Origin: 'http://localhost:5999' } })).status).toBe(403);
    expect((await send('/100', { method: 'PUT', json: { revision: 0, ...empty }, headers: { Origin: 'http://localhost:5999' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/local/corrections/100`, { method: 'PUT', body: JSON.stringify({ revision: 0, ...empty }), headers: { 'Content-Type': 'application/json' } })).status).toBe(403);
    expect((await send('/100', { method: 'PUT', json: { revision: 0, ...empty }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(403);
    expect((await send('/100', { method: 'DELETE' })).status).toBe(405);
    expect((await send('/', { method: 'POST', json: empty })).status).toBe(405);
    expect((await send('/100/import', { method: 'GET' })).status).toBe(405);
    expect((await send('/100/other', { method: 'POST', json: empty })).status).toBe(404);
  });

  it('reports invalid course IDs, bodies and sizes with error codes', async () => {
    const codes = async (response: Response) => [response.status, (await response.json()).error];
    expect(await codes(await fetch(`${origin}/api/local/corrections?courseId=..%2Fx`))).toEqual([400, 'INVALID_COURSE_ID']);
    expect(await codes(await send('/..%2Fx/import', { method: 'POST', json: empty }))).toEqual([400, 'INVALID_COURSE_ID']);
    expect(await codes(await send('/100', { method: 'PUT', body: '{ not json' }))).toEqual([400, 'INVALID_BODY']);
    expect(await codes(await send('/100', { method: 'PUT', json: { corrections: {}, manual: [], order: [] } }))).toEqual([400, 'INVALID_BODY']);
    expect(await codes(await send('/100/import', { method: 'POST', body: JSON.stringify({ ...empty, pad: 'x'.repeat(1_000_001) }) }))).toEqual([413, 'TOO_LARGE']);
    await stat(file()).then(() => { throw new Error('a file was written'); }, () => undefined);
  });

  it('answers 500 CORRECTIONS_UNREADABLE for a damaged file and keeps it', async () => {
    await mkdir(join(dir, '.local', 'corrections'), { recursive: true });
    await writeFile(file(), '{ not json');
    const response = await send('/100', { method: 'PUT', json: { revision: 0, ...empty } });
    expect([response.status, (await response.json()).error]).toEqual([500, 'CORRECTIONS_UNREADABLE']);
    expect(await readFile(file(), 'utf8')).toBe('{ not json');
  });
});
