import { describe, expect, it } from 'vitest';
import { correctionSlices, markMigrated, migratedCourses, migratedKey, migrationPlan, writeCourseSlice, migrateStoredKeys, storageKeys } from '../web/src/local-stores.js';

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
      'coursework.other': 'untouched',
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
    expect(storage.data.get('coursework.other')).toBe('untouched');

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
