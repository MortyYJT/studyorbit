import { describe, expect, it } from 'vitest';
import { applyChoiceToSlice, importCourse, correctionSlices, markMigrated, migratedCourses, migratedKey, migrationPlan, writeCourseSlice, migrateStoredKeys, storageKeys } from '../web/src/local-stores.js';

// A synthetic in-memory stand-in for the browser's localStorage.
function memoryStorage(initial: Record<string, unknown>, failOn: string[] = []) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  const writes: string[] = [];
  return {
    data, writes,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failOn.includes(key)) throw new Error('quota'); writes.push(key); data.set(key, value); },
  };
}
const read = (storage: ReturnType<typeof memoryStorage>, key: string) => JSON.parse(storage.data.get(key)!);

describe('migrateStoredKeys', () => {
  it('moves every browser store of each course and writes only changed stores', () => {
    const storage = memoryStorage({
      [storageKeys.corrections]: { '100:a1': { weight: 30 }, '100:group:100:quizzes': { weight: 20 }, '200:b1': { parent: '200:old' } },
      [storageKeys.manual]: { 100: [{ key: '100:manual:m1', parent: '100:a1' }] },
      [storageKeys.order]: { 100: ['100:a1', '100:canvas:5551'] },
      [storageKeys.work]: [{ key: '100:group:100:quizzes', courseId: '100' }, { key: 'task:1', courseId: '' }],
      'studyorbit.other': 'untouched',
    });
    const result = migrateStoredKeys(storage, [
      { courseId: '100', legacyIds: { a1: 'canvas:5551', quizzes: 'canvas-group:300' } },
      { courseId: '200', legacyIds: { old: 'canvas:9' } },
    ]);
    expect(result).toEqual({ changed: true, failed: false });
    expect(read(storage, storageKeys.corrections)).toEqual({ '100:canvas:5551': { weight: 30 }, '100:group:100:canvas-group:300': { weight: 20 }, '200:b1': { parent: '200:canvas:9' } });
    expect(read(storage, storageKeys.manual)).toEqual({ 100: [{ key: '100:manual:m1', parent: '100:canvas:5551' }] });
    expect(read(storage, storageKeys.order)).toEqual({ 100: ['100:canvas:5551'] });
    expect(read(storage, storageKeys.work)).toEqual([{ key: '100:group:100:canvas-group:300', courseId: '100' }, { key: 'task:1', courseId: '' }]);
    expect(storage.data.get('studyorbit.other')).toBe('untouched');

    storage.writes.length = 0;
    expect(migrateStoredKeys(storage, [{ courseId: '100', legacyIds: { a1: 'canvas:5551', quizzes: 'canvas-group:300' } }])).toEqual({ changed: false, failed: false });
    expect(storage.writes).toEqual([]);
  });

  it('never rewrites a store it could not read', () => {
    const storage = memoryStorage({ [storageKeys.corrections]: '{not json', [storageKeys.order]: { 100: ['100:a1'] } });
    expect(migrateStoredKeys(storage, [{ courseId: '100', legacyIds: { a1: 'canvas:5551' } }])).toEqual({ changed: true, failed: false });
    expect(storage.data.get(storageKeys.corrections)).toBe('{not json');
    expect(storage.writes).toEqual([storageKeys.order]);
  });

  it('does nothing without stores or maps', () => {
    const storage = memoryStorage({});
    expect(migrateStoredKeys(storage, [{ courseId: '100', legacyIds: { a1: 'canvas:5551' } }])).toEqual({ changed: false, failed: false });
    expect(migrateStoredKeys(storage, [])).toEqual({ changed: false, failed: false });
    expect(storage.writes).toEqual([]);
  });

  it('reports a failed write and keeps going', () => {
    const storage = memoryStorage({ [storageKeys.corrections]: { '100:a1': {} }, [storageKeys.order]: { 100: ['100:a1'] } }, [storageKeys.corrections]);
    expect(migrateStoredKeys(storage, [{ courseId: '100', legacyIds: { a1: 'canvas:5551' } }])).toEqual({ changed: true, failed: true });
    expect(read(storage, storageKeys.order)).toEqual({ 100: ['100:canvas:5551'] });
  });
});

describe('corrections migration helpers', () => {
  const seeded = () => memoryStorage({
    [storageKeys.corrections]: { '100:a1': { weight: 30 }, '100:group:100:p1': { name: 'P' }, '200:b1': { hidden: true }, 'task:x': { weight: 1 }, 'abc:1': { weight: 2 } },
    [storageKeys.manual]: { 300: [{ key: '300:manual:m1', name: 'Manual' }], 400: [], other: [{ key: 'x' }] },
    [storageKeys.order]: { 500: ['500:a1'], 100: ['100:a1'], 600: [] },
  });

  it('splits browser stores into per-course slices for courses with corrections, manual items or an order list', () => {
    const { slices, complete } = correctionSlices(seeded());
    expect(complete).toBe(true);
    expect(slices).toEqual({
      100: { corrections: { '100:a1': { weight: 30 }, '100:group:100:p1': { name: 'P' } }, manual: [], order: ['100:a1'] },
      200: { corrections: { '200:b1': { hidden: true } }, manual: [], order: [] },
      300: { corrections: {}, manual: [{ key: '300:manual:m1', name: 'Manual' }], order: [] },
      500: { corrections: {}, manual: [], order: ['500:a1'] },
    });
  });

  it('plans imports for unmarked courses only and records each course in the marker', () => {
    const storage = seeded();
    expect(migratedCourses(storage)).toEqual([]);
    expect(migrationPlan(storage).imports.map(entry => entry.courseId)).toEqual(['100', '200', '300', '500']);
    expect(markMigrated(storage, '200')).toBe(true);
    expect(markMigrated(storage, '200')).toBe(true);
    expect(read(storage, migratedKey)).toEqual({ courses: ['200'] });
    const plan = migrationPlan(storage);
    expect(plan.imports.map(entry => entry.courseId)).toEqual(['100', '300', '500']);
    expect(plan.local).toEqual(['100', '300', '500']);
  });

  it('imports nothing while a store cannot be read, and treats an unreadable marker as empty', () => {
    const storage = memoryStorage({ [storageKeys.corrections]: '{not json', [storageKeys.order]: { 100: ['100:a1'] }, [migratedKey]: 'oops' });
    expect(correctionSlices(storage).complete).toBe(false);
    expect(migrationPlan(storage)).toEqual({ imports: [], local: ['100'] });
    expect(migratedCourses(storage)).toEqual([]);
  });

  it('reports a failed marker write so the course is retried', () => {
    const storage = memoryStorage({}, [migratedKey]);
    expect(markMigrated(storage, '100')).toBe(false);
  });

  it('writes one course back to browser storage and leaves the other courses as they are', () => {
    const storage = seeded();
    expect(writeCourseSlice(storage, '100', { corrections: { '100:a2': { weight: 5 } }, manual: [{ key: '100:manual:n', name: 'New' }], order: [] })).toBe(true);
    expect(read(storage, storageKeys.corrections)).toEqual({ '200:b1': { hidden: true }, 'task:x': { weight: 1 }, 'abc:1': { weight: 2 }, '100:a2': { weight: 5 } });
    expect(read(storage, storageKeys.manual)).toEqual({ 300: [{ key: '300:manual:m1', name: 'Manual' }], 400: [], other: [{ key: 'x' }], 100: [{ key: '100:manual:n', name: 'New' }] });
    expect(read(storage, storageKeys.order)).toEqual({ 500: ['500:a1'], 600: [] });
  });

  it('never rewrites an unreadable store when writing a course back', () => {
    const storage = memoryStorage({ [storageKeys.corrections]: '{not json' });
    expect(writeCourseSlice(storage, '100', { corrections: {}, manual: [], order: [] })).toBe(false);
    expect(storage.data.get(storageKeys.corrections)).toBe('{not json');
    expect(storage.writes).toEqual([]);
  });
});

describe('importCourse', () => {
  const slice = { corrections: { '100:a1': { weight: 30 } }, manual: [], order: ['100:a1'] };
  const view = (patch: Record<string, unknown> = {}) => ({ exists: true, revision: 3, corrections: { '100:a1': { weight: 30 } }, manual: [], order: ['100:a1'], conflicts: [], ...patch });
  // A scripted stand-in for the corrections API: answers in order and records every call.
  function api(...answers: { ok: boolean; status: number; body: unknown }[]) {
    const calls: [string, string, unknown][] = [];
    return { calls, request: async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => { calls.push([method, path, body]); const next = answers.shift(); if (!next) throw new Error('network'); return next; } };
  }

  it('marks the course after a successful import', async () => {
    const storage = memoryStorage({});
    const server = api({ ok: true, status: 201, body: { imported: true, store: view({ revision: 1 }) } });
    expect(await importCourse(storage, server.request, '100', slice)).toBe(true);
    expect(server.calls).toEqual([['POST', '/api/local/corrections/100/import', slice]]);
    expect(migratedCourses(storage)).toEqual(['100']);
  });

  it('sends browser edits made after an unrecorded earlier import before switching to the server copy', async () => {
    const storage = memoryStorage({});
    const edited = { ...slice, corrections: { '100:a1': { weight: 35 } } };
    const server = api({ ok: true, status: 200, body: { imported: false } }, { ok: true, status: 200, body: view() }, { ok: true, status: 200, body: view({ revision: 4, corrections: { '100:a1': { weight: 35 } } }) });
    expect(await importCourse(storage, server.request, '100', edited)).toBe(true);
    expect(server.calls.slice(1)).toEqual([['GET', '/api/local/corrections?courseId=100', undefined], ['PUT', '/api/local/corrections/100', { revision: 3, ...edited }]]);
    expect(migratedCourses(storage)).toEqual(['100']);
  });

  it('does not write when the server copy already matches', async () => {
    const storage = memoryStorage({});
    const server = api({ ok: true, status: 200, body: { imported: false } }, { ok: true, status: 200, body: view() });
    expect(await importCourse(storage, server.request, '100', slice)).toBe(true);
    expect(server.calls.map(call => call[0])).toEqual(['POST', 'GET']);
  });

  it('leaves the course on browser storage when any step fails, so the next load retries', async () => {
    for (const server of [
      api(),
      api({ ok: false, status: 500, body: { error: 'CORRECTIONS_UNREADABLE' } }),
      api({ ok: true, status: 200, body: { imported: false } }),
      api({ ok: true, status: 200, body: { imported: false } }, { ok: true, status: 200, body: view({ corrections: {} }) }, { ok: false, status: 409, body: { error: 'REVISION_MISMATCH' } }),
    ]) {
      const storage = memoryStorage({});
      expect(await importCourse(storage, server.request, '100', slice)).toBe(false);
      expect(migratedCourses(storage)).toEqual([]);
    }
    const quota = memoryStorage({}, [migratedKey]);
    expect(await importCourse(quota, api({ ok: true, status: 201, body: { imported: true } }).request, '100', slice)).toBe(false);
  });
});

describe('applyChoiceToSlice (review of PR #271)', () => {
  const conflict = (type: 'field' | 'orphaned' | 'dangling', field: string | null, user: unknown) => ({ id: '0123456789abcdef', type, key: '100:a1', assessmentId: 'a1', field, base: null, incoming: null, user, detectedAt: '2026-10-30T00:00:00.000Z' });
  const slice = (correction: Record<string, unknown>) => ({ corrections: { '100:a1': correction, '100:a2': { name: 'Other' } }, manual: [], order: ['100:a1'] });

  it('sync on a field drops that field from a waiting local copy, keeping the newer edit of another field', () => {
    expect(applyChoiceToSlice(slice({ weight: 30, name: 'Edited meanwhile' }), conflict('field', 'weight', 30), 'sync', 'Australia/Melbourne').corrections)
      .toEqual({ '100:a1': { name: 'Edited meanwhile' }, '100:a2': { name: 'Other' } });
    expect(applyChoiceToSlice(slice({ weight: 30 }), conflict('field', 'weight', 30), 'sync', 'Australia/Melbourne').corrections).toEqual({ '100:a2': { name: 'Other' } });
  });

  it('keeps a field the owner changed again after choosing', () => {
    expect(applyChoiceToSlice(slice({ weight: 33 }), conflict('field', 'weight', 30), 'sync', 'Australia/Melbourne').corrections['100:a1']).toEqual({ weight: 33 });
  });

  it('sync on an orphaned conflict drops the whole correction; dangling drops the reference; mine changes nothing', () => {
    expect(applyChoiceToSlice(slice({ weight: 8, name: 'X' }), conflict('orphaned', null, { weight: 8 }), 'sync', 'Australia/Melbourne').corrections).toEqual({ '100:a2': { name: 'Other' } });
    expect(applyChoiceToSlice(slice({ mergeInto: '100:a9', hidden: true }), conflict('dangling', 'mergeInto', '100:a9'), 'sync', 'Australia/Melbourne').corrections['100:a1']).toEqual({ hidden: true });
    const waiting = slice({ weight: 30 });
    expect(applyChoiceToSlice(waiting, conflict('field', 'weight', 30), 'mine', 'Australia/Melbourne')).toBe(waiting);
  });
});
