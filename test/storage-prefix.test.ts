import { describe, expect, it } from 'vitest';
import { migrateBackgroundImage, migrateStoragePrefix, NEW_PREFIX, OLD_PREFIX } from '../web/src/storage-prefix.js';

// A synthetic in-memory stand-in for the browser's localStorage.
function memoryStorage(initial: Record<string, string>, failOn: string[] = []) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data, writes,
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failOn.includes(key)) throw new Error('quota'); writes.push(key); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe('migrateStoragePrefix', () => {
  it('uses the old and new prefixes', () => {
    expect(OLD_PREFIX).toBe('coursework.');
    expect(NEW_PREFIX).toBe('studyorbit.');
  });

  it('moves every old-prefix key to the new prefix and removes the old key', () => {
    const storage = memoryStorage({ 'coursework.theme': 'dark', 'coursework.local-planning.work.v1': '[1]', 'other.key': 'x' });
    expect(migrateStoragePrefix(storage)).toEqual({ moved: 2, failed: false });
    expect(Object.fromEntries(storage.data)).toEqual({ 'studyorbit.theme': 'dark', 'studyorbit.local-planning.work.v1': '[1]', 'other.key': 'x' });
  });

  it('keeps a value already under the new prefix and still drops the old key', () => {
    const storage = memoryStorage({ 'coursework.palette': 'pine', 'studyorbit.palette': 'mono' });
    expect(migrateStoragePrefix(storage)).toEqual({ moved: 0, failed: false });
    expect(Object.fromEntries(storage.data)).toEqual({ 'studyorbit.palette': 'mono' });
  });

  it('does nothing the second time', () => {
    const storage = memoryStorage({ 'coursework.language': 'en' });
    migrateStoragePrefix(storage);
    storage.writes.length = 0;
    expect(migrateStoragePrefix(storage)).toEqual({ moved: 0, failed: false });
    expect(storage.writes).toEqual([]);
  });

  it('keeps the old key when the new one cannot be written', () => {
    const storage = memoryStorage({ 'coursework.avatar': 'data:x', 'coursework.theme': 'dark' }, ['studyorbit.avatar']);
    expect(migrateStoragePrefix(storage)).toEqual({ moved: 1, failed: true });
    expect(Object.fromEntries(storage.data)).toEqual({ 'coursework.avatar': 'data:x', 'studyorbit.theme': 'dark' });
  });
  it('moves a value too large to hold twice by freeing the old key first', () => {
    const big = 'x'.repeat(60);
    const data = new Map<string, string>([['coursework.avatar', big], ['coursework.theme', 'dark']]);
    const quota = 100; // total characters, like a browser's per-origin localStorage quota
    const used = () => [...data].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
    const storage = {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        const before = data.get(key);
        data.set(key, value);
        if (used() > quota) { if (before === undefined) data.delete(key); else data.set(key, before); throw new Error('QuotaExceededError'); }
      },
      removeItem: (key: string) => { data.delete(key); },
    };
    expect(migrateStoragePrefix(storage)).toEqual({ moved: 2, failed: false });
    expect(Object.fromEntries(data)).toEqual({ 'studyorbit.avatar': big, 'studyorbit.theme': 'dark' });
  });
});

describe('migrateBackgroundImage', () => {
  function fakeDatabases(initial: Record<string, Blob | undefined>, failWrite = false) {
    const images = new Map(Object.entries(initial));
    const removed: string[] = [];
    return {
      images, removed,
      read: async (name: string) => images.get(name),
      write: async (name: string, blob: Blob) => { if (failWrite) throw new Error('quota'); images.set(name, blob); },
      remove: async (name: string) => { removed.push(name); images.delete(name); },
    };
  }
  const image = new Blob(['x'], { type: 'image/webp' });

  it('copies the image from the old database and deletes the old database', async () => {
    const io = fakeDatabases({ coursework: image });
    expect(await migrateBackgroundImage(io)).toBe('moved');
    expect(io.images.get('studyorbit')).toBe(image);
    expect(io.removed).toEqual(['coursework']);
  });

  it('keeps an image already in the new database and deletes the old database', async () => {
    const newer = new Blob(['y'], { type: 'image/webp' });
    const io = fakeDatabases({ coursework: image, studyorbit: newer });
    expect(await migrateBackgroundImage(io)).toBe('kept');
    expect(io.images.get('studyorbit')).toBe(newer);
    expect(io.removed).toEqual(['coursework']);
  });

  it('deletes an empty old database', async () => {
    const io = fakeDatabases({});
    expect(await migrateBackgroundImage(io)).toBe('none');
    expect(io.removed).toEqual(['coursework']);
  });

  it('keeps the old database when the copy fails', async () => {
    const io = fakeDatabases({ coursework: image }, true);
    expect(await migrateBackgroundImage(io)).toBe('failed');
    expect(io.removed).toEqual([]);
    expect(io.images.get('coursework')).toBe(image);
  });
});
