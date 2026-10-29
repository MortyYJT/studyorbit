// Browser storage of the owner's local planning data, and the one-time move of its keys to new assessment IDs.
import { migrateLocalKeys, type LocalStores } from '../../shared/local-keys.js';

export const storageKeys = {
  work: 'coursework.local-planning.work.v1',
  corrections: 'coursework.local-planning.corrections.v1',
  manual: 'coursework.local-planning.assessments.v1',
  order: 'coursework.local-planning.order.v1',
} as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Slot = 'corrections' | 'manual' | 'order' | 'work';
const slots: Slot[] = ['corrections', 'manual', 'order', 'work'];

// The stored JSON text, the parsed value, or `undefined` when the store exists but cannot be read (never rewritten).
function readSlot(storage: StorageLike, slot: Slot): { text: string | null; value: unknown } | undefined {
  let text: string | null;
  try { text = storage.getItem(storageKeys[slot]); } catch { return undefined; }
  if (text === null) return { text, value: slot === 'work' ? [] : {} };
  try {
    const value: unknown = JSON.parse(text);
    const ok = slot === 'work' ? Array.isArray(value) : !!value && typeof value === 'object' && !Array.isArray(value);
    return ok ? { text, value } : undefined;
  } catch { return undefined; }
}

/**
 * Applies each course's `legacyIds` (from its course document v2) to the corrections, manual assessments, order lists and
 * planned work in browser storage with the shared `migrateLocalKeys`, and writes back only the stores that changed.
 * A store that cannot be read is left exactly as it is. Idempotent, so it runs on every course-reports load.
 * Returns whether anything changed and whether a write failed (the next load retries).
 */
export function migrateStoredKeys(storage: StorageLike, migrations: { courseId: string; legacyIds: Record<string, string> }[]): { changed: boolean; failed: boolean } {
  if (!migrations.some(entry => Object.keys(entry.legacyIds).length)) return { changed: false, failed: false };
  const read = Object.fromEntries(slots.map(slot => [slot, readSlot(storage, slot)])) as Record<Slot, ReturnType<typeof readSlot>>;
  let stores: LocalStores = {
    corrections: (read.corrections?.value ?? {}) as LocalStores['corrections'], manual: (read.manual?.value ?? {}) as LocalStores['manual'],
    order: (read.order?.value ?? {}) as LocalStores['order'], work: (read.work?.value ?? []) as LocalStores['work'],
  };
  for (const { courseId, legacyIds } of migrations) stores = migrateLocalKeys(stores, courseId, legacyIds).stores;
  let changed = false, failed = false;
  for (const slot of slots) {
    const before = read[slot];
    if (!before) continue;
    const text = JSON.stringify(stores[slot]);
    if (text === JSON.stringify(before.value)) continue;
    changed = true;
    try { storage.setItem(storageKeys[slot], text); } catch { failed = true; }
  }
  return { changed, failed };
}
