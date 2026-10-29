import { describe, expect, it } from 'vitest';
import { migrateLocalKeys, migrateKey, type LocalStores } from '../shared/local-keys.js';

// Synthetic course IDs and keys only.
const stores = (patch: Partial<LocalStores> = {}): LocalStores => ({ corrections: {}, manual: {}, order: {}, work: [], ...patch });

describe('migrateKey', () => {
  const map = { a1: 'canvas:5551', quizzes: 'canvas-group:300' };
  it('rewrites item and group keys of the course and leaves the rest', () => {
    expect(migrateKey('100:a1', '100', map)).toBe('100:canvas:5551');
    expect(migrateKey('100:group:100:quizzes', '100', map)).toBe('100:group:100:canvas-group:300');
    expect(migrateKey('200:a1', '100', map)).toBe('200:a1');
    expect(migrateKey('100:group:200:a1', '100', map)).toBe('100:group:200:a1');
    expect(migrateKey('100:manual:x', '100', map)).toBe('100:manual:x');
    expect(migrateKey('task:abc', '100', map)).toBe('task:abc');
  });
});

describe('migrateLocalKeys', () => {
  it('moves a group correction and planned work together', () => {
    const input = stores({
      corrections: { '100:group:100:quizzes': { weight: 25 } },
      work: [{ key: '100:quizzes', courseId: '100', title: 'Quizzes' }, { key: '100:group:100:quizzes', courseId: '100', title: 'All quizzes' }],
    });
    const { stores: result, changed, moved } = migrateLocalKeys(input, '100', { quizzes: 'canvas-group:300' });
    expect(changed).toBe(true);
    expect(result.corrections).toEqual({ '100:group:100:canvas-group:300': { weight: 25 } });
    expect(result.work.map(task => task?.key)).toEqual(['100:canvas-group:300', '100:group:100:canvas-group:300']);
    expect(moved).toEqual({ '100:group:100:quizzes': '100:group:100:canvas-group:300' });
    expect(input.corrections).toEqual({ '100:group:100:quizzes': { weight: 25 } });
  });

  it('rewrites parent and mergeInto values inside the course\'s corrections', () => {
    const { stores: result } = migrateLocalKeys(stores({
      corrections: { '100:b2': { mergeInto: '100:a1' }, '100:c3': { parent: '100:a1', name: 'C' }, '100:manual:m1': { parent: '100:a1' }, '200:x': { parent: '100:a1' } },
    }), '100', { a1: 'canvas:5551' });
    expect(result.corrections).toEqual({
      '100:b2': { mergeInto: '100:canvas:5551' }, '100:c3': { parent: '100:canvas:5551', name: 'C' },
      '100:manual:m1': { parent: '100:canvas:5551' }, '200:x': { parent: '100:a1' },
    });
  });

  it('moves the item correction key and keeps its fields', () => {
    const { stores: result } = migrateLocalKeys(stores({ corrections: { '100:a1': { weight: 30, hidden: false } } }), '100', { a1: 'canvas:5551' });
    expect(result.corrections).toEqual({ '100:canvas:5551': { weight: 30, hidden: false } });
  });

  it('rewrites the parent of manual assessments of the course only', () => {
    const { stores: result } = migrateLocalKeys(stores({
      manual: { 100: [{ key: '100:manual:m1', parent: '100:a1' }, { key: '100:manual:m2', parent: '' }], 200: [{ key: '200:manual:m3', parent: '100:a1' }] },
    }), '100', { a1: 'canvas:5551' });
    expect(result.manual).toEqual({
      100: [{ key: '100:manual:m1', parent: '100:canvas:5551' }, { key: '100:manual:m2', parent: '' }], 200: [{ key: '200:manual:m3', parent: '100:a1' }],
    });
  });

  it('rewrites and de-duplicates the order list, keeping the first occurrence', () => {
    const { stores: result } = migrateLocalKeys(stores({
      order: { 100: ['100:a1', '100:group:100:quizzes', '100:canvas:5551', '100:manual:m1'], 200: ['200:a1'] },
    }), '100', { a1: 'canvas:5551', quizzes: 'canvas-group:300' });
    expect(result.order).toEqual({ 100: ['100:canvas:5551', '100:group:100:canvas-group:300', '100:manual:m1'], 200: ['200:a1'] });
  });

  it('leaves an old correction in place when the new key already has one', () => {
    const { stores: result, moved, superseded } = migrateLocalKeys(stores({
      corrections: { '100:a1': { weight: 10 }, '100:canvas:5551': { weight: 20 } },
    }), '100', { a1: 'canvas:5551' });
    expect(result.corrections).toEqual({ '100:a1': { weight: 10 }, '100:canvas:5551': { weight: 20 } });
    expect(moved).toEqual({});
    expect(superseded).toEqual({ '100:a1': '100:canvas:5551' });
  });

  it('keeps both planned tasks when the new key is already planned', () => {
    const { stores: result } = migrateLocalKeys(stores({
      work: [{ key: '100:a1', title: 'old' }, { key: '100:canvas:5551', title: 'new' }],
    }), '100', { a1: 'canvas:5551' });
    expect(result.work).toEqual([{ key: '100:a1', title: 'old' }, { key: '100:canvas:5551', title: 'new' }]);
  });

  it('is idempotent', () => {
    const map = { a1: 'canvas:5551', quizzes: 'canvas-group:300' };
    const input = stores({
      corrections: { '100:a1': { parent: '100:quizzes' }, '100:group:100:quizzes': { weight: 25 }, '100:x': { mergeInto: '100:a1' } },
      manual: { 100: [{ key: '100:manual:m1', parent: '100:a1' }] },
      order: { 100: ['100:a1', '100:canvas:5551'] },
      work: [{ key: '100:a1' }, { key: '100:canvas:5551' }, { key: 'task:1' }],
    });
    const once = migrateLocalKeys(input, '100', map);
    const twice = migrateLocalKeys(once.stores, '100', map);
    expect(once.changed).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.stores).toEqual(once.stores);
  });

  it('changes nothing for an empty map or another course', () => {
    const input = stores({ corrections: { '100:a1': { weight: 1 } }, order: { 100: ['100:a1'] }, work: [{ key: '100:a1' }] });
    expect(migrateLocalKeys(input, '100', {})).toMatchObject({ changed: false, stores: input });
    expect(migrateLocalKeys(input, '200', { a1: 'canvas:5551' })).toMatchObject({ changed: false, stores: input });
  });

  it('ignores chained or self entries so a second run cannot move a key again', () => {
    const result = migrateLocalKeys(stores({ corrections: { '100:a': {}, '100:b': { x: 1 } } }), '100', { a: 'b', b: 'c', d: 'd' });
    expect(result.stores.corrections).toEqual({ '100:a': {}, '100:c': { x: 1 } });
  });

  it('tolerates malformed stores', () => {
    const odd = { corrections: { '100:a1': null }, manual: { 100: 'oops' }, order: { 100: 'oops' }, work: [null, { key: 3 }, { key: '100:a1' }] } as unknown as LocalStores;
    const { stores: result } = migrateLocalKeys(odd, '100', { a1: 'canvas:5551' });
    expect(result.corrections).toEqual({ '100:canvas:5551': null });
    expect(result.manual).toEqual({ 100: 'oops' });
    expect(result.order).toEqual({ 100: 'oops' });
    expect(result.work).toEqual([null, { key: 3 }, { key: '100:canvas:5551' }]);
  });
});
