import { describe, expect, it } from 'vitest';
import { migrateStoredKeys, storageKeys } from '../web/src/local-stores.js';

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
