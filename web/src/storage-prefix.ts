// One-time move of browser data from the project's former storage prefix to `studyorbit.` (decision #495).
// Pure over the storage and database interfaces it is given, so tests run in Node without a browser.

export const OLD_PREFIX = 'coursework.';
export const NEW_PREFIX = 'studyorbit.';
/** IndexedDB database names for the uploaded background image, before and after the rename. */
export const OLD_IMAGE_DB = 'coursework';
export const NEW_IMAGE_DB = 'studyorbit';

type PrefixStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Copies every `coursework.*` key to `studyorbit.*` unless the new key already has a value, then removes the old key.
 * When two copies do not fit the quota, the old key is removed first. A key whose copy still fails is written back under
 * the old name, so nothing is lost and the next page load tries again.
 */
export function migrateStoragePrefix(storage: PrefixStorage): { moved: number; failed: boolean } {
  const oldKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(OLD_PREFIX)) oldKeys.push(key);
  }
  let moved = 0, failed = false;
  for (const oldKey of oldKeys) {
    const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length);
    const value = storage.getItem(oldKey);
    if (value === null) continue;
    if (storage.getItem(newKey) === null) {
      try { storage.setItem(newKey, value); } catch {
        // Two copies may not fit the origin's quota (a large avatar): free the old key, then write the new one.
        storage.removeItem(oldKey);
        try { storage.setItem(newKey, value); } catch {
          try { storage.setItem(oldKey, value); } catch { /* The freed space is the value's own, so this should not fail. */ }
          failed = true;
          continue;
        }
      }
      moved += 1;
    }
    storage.removeItem(oldKey);
  }
  return { moved, failed };
}

export type ImageDatabases = {
  read(name: string): Promise<Blob | undefined>;
  write(name: string, blob: Blob): Promise<void>;
  remove(name: string): Promise<void>;
};

/**
 * Moves the background image from the old IndexedDB database to the new one and deletes the old database.
 * An image already in the new database wins. When the copy fails the old database is kept for the next attempt.
 */
export async function migrateBackgroundImage(io: ImageDatabases): Promise<'moved' | 'kept' | 'none' | 'failed'> {
  const current = await io.read(NEW_IMAGE_DB);
  const previous = await io.read(OLD_IMAGE_DB);
  const outcome: 'moved' | 'kept' | 'none' = current ? 'kept' : previous ? 'moved' : 'none';
  if (outcome === 'moved') {
    try { await io.write(NEW_IMAGE_DB, previous!); } catch { return 'failed'; }
  }
  await io.remove(OLD_IMAGE_DB);
  return outcome;
}
