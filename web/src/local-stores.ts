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

/** Courses whose corrections, manual items and order list now live in `.local/corrections/` (decision #294). */
export const migratedKey = 'coursework.corrections-migrated.v1';
const courseIdPattern = /^\d{1,20}$/;
const coursePrefix = /^(\d{1,20}):/;

export type CourseSlice = { corrections: Record<string, unknown>; manual: unknown[]; order: string[] };

/**
 * The corrections, manual items and order list of each course in browser storage, for courses with any of them.
 * Corrections are grouped by their `<digits>:` key prefix; other keys are ignored. `complete` is false when one of the
 * three stores cannot be read, so nothing is imported from a partial view.
 */
export function correctionSlices(storage: StorageLike): { slices: Record<string, CourseSlice>; complete: boolean } {
  const corrections = readSlot(storage, 'corrections'), manual = readSlot(storage, 'manual'), order = readSlot(storage, 'order');
  const slices: Record<string, CourseSlice> = {};
  const slice = (courseId: string) => (slices[courseId] ??= { corrections: {}, manual: [], order: [] });
  for (const [key, value] of Object.entries((corrections?.value ?? {}) as Record<string, unknown>)) {
    const courseId = coursePrefix.exec(key)?.[1];
    if (courseId) slice(courseId).corrections[key] = value;
  }
  for (const [courseId, items] of Object.entries((manual?.value ?? {}) as Record<string, unknown>)) {
    if (courseIdPattern.test(courseId) && Array.isArray(items) && items.length) slice(courseId).manual = items;
  }
  for (const [courseId, keys] of Object.entries((order?.value ?? {}) as Record<string, unknown>)) {
    if (courseIdPattern.test(courseId) && Array.isArray(keys) && keys.length) slice(courseId).order = keys;
  }
  return { slices, complete: !!corrections && !!manual && !!order };
}

/** Course IDs recorded as migrated; an unreadable marker reads as none (the server answers a repeated import with `imported: false`). */
export function migratedCourses(storage: StorageLike): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(migratedKey) ?? 'null');
    const courses = value && typeof value === 'object' ? (value as { courses?: unknown }).courses : undefined;
    return Array.isArray(courses) ? courses.filter((id): id is string => typeof id === 'string' && courseIdPattern.test(id)) : [];
  } catch { return []; }
}

/** Adds one course to the marker. Returns false when the write fails, so the import is retried on the next load. */
export function markMigrated(storage: StorageLike, courseId: string): boolean {
  const courses = migratedCourses(storage);
  if (courses.includes(courseId)) return true;
  try { storage.setItem(migratedKey, JSON.stringify({ courses: [...courses, courseId] })); return true; } catch { return false; }
}

/**
 * Courses to import now (browser data and not yet in the marker; none while a store is unreadable), and the courses that
 * keep using browser storage until their import succeeds (`local`).
 */
export function migrationPlan(storage: StorageLike): { imports: { courseId: string; slice: CourseSlice }[]; local: string[] } {
  const { slices, complete } = correctionSlices(storage);
  const done = new Set(migratedCourses(storage));
  const local = Object.keys(slices).filter(courseId => !done.has(courseId));
  return { imports: complete ? local.map(courseId => ({ courseId, slice: slices[courseId]! })) : [], local };
}

/**
 * Replaces one course's corrections, manual items and order list in browser storage and keeps every other course as it
 * is (for a course whose import has not succeeded yet). Returns false, writing nothing, when a store cannot be read.
 */
export function writeCourseSlice(storage: StorageLike, courseId: string, slice: CourseSlice): boolean {
  const corrections = readSlot(storage, 'corrections'), manual = readSlot(storage, 'manual'), order = readSlot(storage, 'order');
  if (!corrections || !manual || !order) return false;
  const nextCorrections = Object.fromEntries(Object.entries(corrections.value as Record<string, unknown>).filter(([key]) => !key.startsWith(`${courseId}:`)));
  Object.assign(nextCorrections, slice.corrections);
  const withCourse = (store: Record<string, unknown>, value: unknown[]) => {
    const next = { ...store };
    delete next[courseId];
    if (value.length) next[courseId] = value;
    return next;
  };
  try {
    storage.setItem(storageKeys.corrections, JSON.stringify(nextCorrections));
    storage.setItem(storageKeys.manual, JSON.stringify(withCourse(manual.value as Record<string, unknown>, slice.manual)));
    storage.setItem(storageKeys.order, JSON.stringify(withCourse(order.value as Record<string, unknown>, slice.order)));
    return true;
  } catch { return false; }
}
