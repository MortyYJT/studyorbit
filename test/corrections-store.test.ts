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

describe('reconcile on read (PR 2)', () => {
  // A re-synced course: `documents` is read on every call, so replacing an entry stands for a new course file.
  const docOf = (assessments: CourseDocumentV1['assessments']) => v1Doc(assessments);
  const v2Of = (assessments: CourseDocumentV1['assessments'], legacyIds: Record<string, string>): CourseDocumentV2 => ({
    version: 2, course: { id: '100', code: 'SYNT10001', name: 'Synthetic Course', term: null }, materials: [], legacyIds,
    assessments: assessments.map(entry => ({ ...entry, refs: [], weightQuote: null, ruleQuote: null, unsourced: [] })),
  });
  const save = (store: ReturnType<typeof storeWith>, revision: number, corrections: Record<string, unknown>) => store.save('100', { revision, corrections, manual: [], order: [] });

  it('merges only when the newest file differs from the base, advancing the base and the revision once', async () => {
    const documents: Record<string, CourseDocument> = { 100: docOf([item('a1'), item('a2')]) };
    const store = storeWith(documents);
    await save(store, 0, { '100:a1': { name: 'Mine' }, '100:a2': { weight: 30 } });
    expect((await store.read('100')).revision).toBe(1);
    documents[100] = docOf([item('a1', { weight: 25 }), item('a2', { weight: 35 })]);
    const view = await store.read('100');
    expect(view.revision).toBe(2);
    expect(view.corrections).toEqual({ '100:a1': { name: 'Mine' }, '100:a2': { weight: 30 } });
    expect(view.conflicts.map(conflict => [conflict.key, conflict.field, conflict.base, conflict.incoming, conflict.user])).toEqual([['100:a2', 'weight', 20, 35, 30]]);
    const saved = await readJson();
    expect(saved.base.digest).toBe(digest(documents[100]!));
    expect(saved.base.assessments.a1.weight).toBe(25);
    const text = await readFile(file(), 'utf8');
    expect(await store.read('100')).toEqual(view);
    expect((await store.list()).courses[100]).toEqual(view);
    expect(await readFile(file(), 'utf8')).toBe(text);
  });

  it('two syncs without a read merge against the older base', async () => {
    const documents: Record<string, CourseDocument> = { 100: docOf([item('a1')]) };
    const store = storeWith(documents);
    await save(store, 0, { '100:a1': { weight: 30 } });
    documents[100] = docOf([item('a1', { weight: 30 })]); // file B, never read
    documents[100] = docOf([item('a1', { weight: 30, name: 'Renamed' })]); // file C
    await store.read('100');
    // Against B the owner value would equal the base and be dropped; against A both changed alike, so it is pinned.
    const saved = await readJson();
    expect(saved.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(saved.pins).toEqual({ '100:a1': ['weight'] });
  });

  it('a course without a readable course file is returned as stored', async () => {
    const documents: Record<string, CourseDocument | null> = { 100: docOf([item('a1')]) };
    await save(storeWith(documents), 0, { '100:a1': { weight: 30 } });
    const text = await readFile(file(), 'utf8');
    documents[100] = null;
    expect((await storeWith(documents).read('100')).revision).toBe(1);
    const failing = createCorrectionsStore({ projectDir: dir, loadDocument: async () => { throw new Error('disk'); } });
    expect((await failing.read('100')).revision).toBe(1);
    expect(await readFile(file(), 'utf8')).toBe(text);
  });

  it('moves keys, base, pins and open conflicts through legacyIds, so a renamed pinned field still raises a conflict', async () => {
    const documents: Record<string, CourseDocument> = { 100: docOf([item('a1'), item('a2')]) };
    const store = storeWith(documents);
    await save(store, 0, { '100:a1': { weight: 30, name: 'Mine' }, '100:a2': { mergeInto: '100:a1' } });
    // Sync 1 converges on the weight (pin) and changes the name (conflict).
    documents[100] = docOf([item('a1', { weight: 30, name: 'Synced' }), item('a2')]);
    const first = await store.read('100');
    expect(first.conflicts.map(conflict => conflict.id)).toEqual([conflictId('field', '100:a1', 'name')]);
    expect((await readJson()).pins).toEqual({ '100:a1': ['weight'] });
    // Sync 2 is v2 and renames a1; nothing else changes.
    documents[100] = v2Of([item('canvas:5551', { weight: 30, name: 'Synced' }), item('a2')], { a1: 'canvas:5551' });
    const second = await store.read('100');
    expect(second.corrections).toEqual({ '100:canvas:5551': { weight: 30, name: 'Mine' }, '100:a2': { mergeInto: '100:canvas:5551' } });
    expect(second.conflicts).toEqual([{ ...first.conflicts[0], id: conflictId('field', '100:canvas:5551', 'name'), key: '100:canvas:5551', assessmentId: 'canvas:5551' }]);
    const saved = await readJson();
    expect(saved.pins).toEqual({ '100:canvas:5551': ['weight'] });
    expect(Object.keys(saved.base.assessments)).toEqual(['canvas:5551', 'a2']);
    // Sync 3 changes the pinned weight: the owner value stays and a conflict is raised.
    documents[100] = v2Of([item('canvas:5551', { weight: 25, name: 'Synced' }), item('a2')], { a1: 'canvas:5551' });
    const third = await store.read('100');
    expect(third.corrections['100:canvas:5551']).toEqual({ weight: 30, name: 'Mine' });
    expect(third.conflicts.map(conflict => [conflict.key, conflict.field, conflict.incoming, conflict.user])).toEqual([
      ['100:canvas:5551', 'name', 'Synced', 'Mine'], ['100:canvas:5551', 'weight', 25, 30],
    ]);
    expect(third.revision).toBe(4);
  });

  it('drops the pins and conflicts of an old key whose new key already has its own correction', async () => {
    const documents: Record<string, CourseDocument> = { 100: docOf([item('a1'), item('canvas:5551')]) };
    const store = storeWith(documents);
    await save(store, 0, { '100:a1': { weight: 30 }, '100:canvas:5551': { name: 'Own' } });
    documents[100] = docOf([item('a1', { weight: 30 }), item('canvas:5551')]);
    await store.read('100');
    expect((await readJson()).pins).toEqual({ '100:a1': ['weight'] });
    documents[100] = v2Of([item('canvas:5551')], { a1: 'canvas:5551' });
    const view = await store.read('100');
    const saved = await readJson();
    expect(saved.pins).toEqual({});
    expect(view.corrections['100:canvas:5551']).toEqual({ name: 'Own' });
    expect(view.conflicts.every(conflict => conflict.key !== '100:a1' || conflict.type === 'orphaned')).toBe(true);
  });

  it('flags an old key left unused because its new key has its own correction, once', async () => {
    const documents: Record<string, CourseDocument> = { 100: docOf([item('a1')]) };
    const store = storeWith(documents);
    await save(store, 0, { '100:a1': { weight: 30 }, '100:canvas:5551': { name: 'Own' } });
    documents[100] = v2Of([item('canvas:5551')], { a1: 'canvas:5551' });
    const view = await store.read('100');
    expect(view.corrections).toEqual({ '100:a1': { weight: 30 }, '100:canvas:5551': { name: 'Own' } });
    expect(view.conflicts.map(conflict => [conflict.type, conflict.key])).toEqual([['orphaned', '100:a1']]);
    expect(view.conflicts[0]).toMatchObject({ assessmentId: 'a1', user: { weight: 30 }, base: { name: 'Synthetic a1' } });
    // 「保留」, then another sync: not raised again.
    const kept = await store.resolve('100', view.conflicts[0]!.id, { revision: view.revision, choice: 'mine' });
    documents[100] = v2Of([item('canvas:5551', { weight: 25 })], { a1: 'canvas:5551' });
    expect((await store.read('100')).conflicts).toEqual([]);
    expect(kept.corrections['100:a1']).toEqual({ weight: 30 });
  });

  it('keeps every owner correction in effect across several syncs, including pins and a legacyIds rename', async () => {
    const documents: Record<string, CourseDocument> = { 100: docOf([
      item('a1', { name: 'Essay' }), item('a2', { weight: 15 }), item('g1', { name: 'Quizzes', weight: 10 }), item('q1', { parentId: 'g1', weight: null }), item('a4', { weight: 0 }),
    ]) };
    const store = storeWith(documents);
    const owner = {
      '100:a1': { name: 'My essay', weight: 25 },
      '100:a2': { due: '2026-11-05T12:59:00Z', score: 12, outOf: 20 },
      '100:group:100:g1': { weight: 12 },
      '100:q1': { parent: '' },
      '100:a4': { hidden: true },
    };
    await save(store, 0, owner);
    const syncs = [
      docOf([item('a1', { name: 'Essay', weight: 25 }), item('a2', { weight: 15, due: '2026-11-10T12:59:00Z' }), item('g1', { name: 'Quizzes', weight: 10 }), item('q1', { parentId: 'g1', weight: null }), item('a4', { weight: 0 })]),
      v2Of([item('canvas:5551', { name: 'Essay', weight: 25 }), item('a2', { weight: 15, due: '2026-11-10T12:59:00Z' }), item('canvas-group:300', { name: 'Quizzes', weight: 11 }), item('q1', { parentId: 'canvas-group:300', weight: null }), item('a4', { weight: 0 })],
        { a1: 'canvas:5551', g1: 'canvas-group:300' }),
      v2Of([item('canvas:5551', { name: 'Essay', weight: 30 }), item('a2', { weight: 15, due: '2026-11-12T12:59:00Z', score: 18, maxScore: 20 }), item('canvas-group:300', { name: 'Quizzes', weight: 11 }), item('q1', { parentId: 'canvas-group:300', weight: null }), item('a4', { weight: 0 })],
        { a1: 'canvas:5551', g1: 'canvas-group:300' }),
    ];
    const renamed: Record<string, string> = { '100:a1': '100:canvas:5551', '100:group:100:g1': '100:group:100:canvas-group:300' };
    let view = await store.read('100');
    for (const document of syncs) {
      documents[100] = document;
      view = await store.read('100');
      const fieldsById = Object.fromEntries(document.assessments.map(entry => [entry.id, entry]));
      for (const [key, correction] of Object.entries(owner)) {
        const now = (document.version === 2 ? renamed[key] : undefined) ?? key;
        for (const [field, value] of Object.entries(correction)) {
          const stored = (view.corrections[now] as Record<string, unknown> | undefined)?.[field];
          const id = now.startsWith('100:group:100:') ? now.slice(14) : now.slice(4);
          const synced = (fieldsById[id] as Record<string, unknown> | undefined)?.[{ outOf: 'maxScore', parent: 'parentId' }[field] ?? field];
          const shown = stored !== undefined ? stored : field === 'parent' ? (synced ? `100:${synced}` : '') : synced;
          expect([document.version, now, field, shown]).toEqual([document.version, now, field, value]);
        }
      }
    }
    // Open conflicts: the group weight (sync 2), the due date and score the owner set differently, and the converged weight
    // the last sync moved. The maximum score converged on the owner's value and raised nothing.
    expect(view.conflicts.map(conflict => [conflict.key, conflict.field]).sort()).toEqual([
      ['100:a2', 'due'], ['100:a2', 'score'], ['100:canvas:5551', 'weight'], ['100:group:100:canvas-group:300', 'weight'],
    ]);
    expect((await readJson()).revision).toBe(4);
  });
});

describe('owner edits and conflict resolution (PR 2)', () => {
  const documents: Record<string, CourseDocument> = {};
  beforeEach(() => { documents[100] = v1Doc([item('a1'), item('a2')]); });
  const setup = async () => {
    const store = storeWith(documents);
    await store.save('100', { revision: 0, corrections: { '100:a1': { weight: 30, due: '2026-11-17T12:59:00Z' }, '100:a2': { name: 'Mine' } }, manual: [], order: [] });
    documents[100] = v1Doc([item('a1', { weight: 25, due: '2026-11-17T12:59:00Z' }), item('a2')]);
    return { store, view: await store.read('100') };
  };

  it('a stale PUT after an unseen sync gets 409 with the reconciled store', async () => {
    const store = storeWith(documents);
    await store.save('100', { revision: 0, corrections: { '100:a1': { weight: 30 } }, manual: [], order: [] });
    documents[100] = v1Doc([item('a1', { weight: 25 }), item('a2')]);
    const error = await store.save('100', { revision: 1, corrections: { '100:a1': { weight: 31 } }, manual: [], order: [] }).catch(caught => caught);
    expect(error.message).toBe('REVISION_MISMATCH');
    expect(error.current).toMatchObject({ revision: 2, corrections: { '100:a1': { weight: 30 } } });
    expect(error.current.conflicts).toHaveLength(1);
  });

  it('a resent value in another notation keeps the stored value, pin and conflict; a changed value closes the conflict and releases the pin', async () => {
    const { store, view } = await setup();
    expect((await readJson()).pins).toEqual({ '100:a1': ['due'] });
    expect(view.conflicts.map(conflict => conflict.field)).toEqual(['weight']);
    const resent = await store.save('100', { revision: view.revision, corrections: { '100:a1': { weight: 30, due: '2026-11-17T23:59:00+11:00' }, '100:a2': { name: 'Mine' } }, manual: [], order: [] });
    expect(resent.corrections['100:a1']).toEqual({ weight: 30, due: '2026-11-17T12:59:00Z' });
    expect(resent.conflicts).toEqual(view.conflicts);
    expect((await readJson()).pins).toEqual({ '100:a1': ['due'] });
    const changed = await store.save('100', { revision: resent.revision, corrections: { '100:a1': { weight: 35, due: '2026-11-18T12:59:00Z' }, '100:a2': { name: 'Mine' } }, manual: [], order: [] });
    expect(changed.corrections['100:a1']).toEqual({ weight: 35, due: '2026-11-18T12:59:00Z' });
    expect(changed.conflicts).toEqual([]);
    expect((await readJson()).pins).toEqual({});
  });

  it('resolves with sync or mine under a revision check; mine is not raised again', async () => {
    const { store, view } = await setup();
    const id = view.conflicts[0]!.id;
    await expect(store.resolve('100', id, { revision: view.revision - 1, choice: 'sync' })).rejects.toThrow('REVISION_MISMATCH');
    await expect(store.resolve('100', 'ffffffffffffffff', { revision: view.revision, choice: 'sync' })).rejects.toThrow('CONFLICT_NOT_FOUND');
    await expect(store.resolve('100', id, { revision: view.revision, choice: 'maybe' })).rejects.toThrow('INVALID_BODY');
    const kept = await store.resolve('100', id, { revision: view.revision, choice: 'mine' });
    expect(kept).toMatchObject({ revision: view.revision + 1, conflicts: [], corrections: { '100:a1': { weight: 30, due: '2026-11-17T12:59:00Z' } } });
    documents[100] = v1Doc([item('a1', { weight: 25, due: '2026-11-17T12:59:00Z', name: 'Renamed' }), item('a2')]);
    expect((await store.read('100')).conflicts).toEqual([]);
  });

  it('choosing the sync value removes the field and its conflict', async () => {
    const { store, view } = await setup();
    const result = await store.resolve('100', view.conflicts[0]!.id, { revision: view.revision, choice: 'sync' });
    expect(result.corrections).toEqual({ '100:a1': { due: '2026-11-17T12:59:00Z' }, '100:a2': { name: 'Mine' } });
    expect(result.conflicts).toEqual([]);
    // Unknown course file, no store: revision 0 and nothing to resolve.
    await expect(store.resolve('200', 'ffffffffffffffff', { revision: 0, choice: 'sync' })).rejects.toThrow('CONFLICT_NOT_FOUND');
  });
});

describe('conflict route (PR 2)', () => {
  let server: Server;
  let origin: string;
  const documents: Record<string, CourseDocument> = {};
  beforeEach(async () => {
    documents[100] = v1Doc();
    const handle = createCorrectionsHandler(storeWith(documents));
    server = createServer((req, res) => { req.url = req.url!.slice('/api/local/corrections'.length) || '/'; void handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });
  const post = (path: string, json: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/local/corrections${path}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(json),
  });

  it('resolves a conflict with revision checks and error codes', async () => {
    await fetch(`${origin}/api/local/corrections/100`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, corrections: { '100:a1': { weight: 30 } }, manual: [], order: [] }) });
    documents[100] = v1Doc([item('a1', { weight: 25 }), item('a2')]);
    const view = await (await fetch(`${origin}/api/local/corrections?courseId=100`)).json() as CorrectionsView;
    const id = view.conflicts[0]!.id;
    const codes = async (response: Response) => [response.status, (await response.json()).error];
    expect(await codes(await post(`/100/conflicts/${id}`, { revision: 1, choice: 'sync' }))).toEqual([409, 'REVISION_MISMATCH']);
    expect(await codes(await post('/100/conflicts/ffffffffffffffff', { revision: view.revision, choice: 'sync' }))).toEqual([404, 'CONFLICT_NOT_FOUND']);
    expect(await codes(await post('/100/conflicts/not-an-id', { revision: view.revision, choice: 'sync' }))).toEqual([404, 'CONFLICT_NOT_FOUND']);
    expect(await codes(await post(`/100/conflicts/${id}`, { revision: view.revision, choice: 'both' }))).toEqual([400, 'INVALID_BODY']);
    expect((await post(`/100/conflicts/${id}`, { revision: view.revision, choice: 'sync' }, { Origin: 'http://localhost:5999' })).status).toBe(403);
    expect((await fetch(`${origin}/api/local/corrections/100/conflicts/${id}`, { method: 'GET' })).status).toBe(405);
    const resolved = await post(`/100/conflicts/${id}`, { revision: view.revision, choice: 'sync' });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ revision: view.revision + 1, corrections: {}, conflicts: [] });
  });
});
