/**
 * Moves the owner's local data to new assessment IDs (openspec/changes/course-contract-v2/design.md §6, decision #278).
 * A course document v2 carries `legacyIds` (earlier assessment ID -> current ID); every local store that refers to synced
 * assessments uses keys built from those IDs:
 *
 * - item key `K(id) = <courseId>:<id>` and group key `G(id) = <courseId>:group:<courseId>:<id>` (a parent's own edits);
 * - corrections, keyed by item or group key, whose `parent` and `mergeInto` values are item keys;
 * - manual assessments per course, whose `parent` is an item key;
 * - planned work, whose `key` is an item or group key;
 * - the per-course order list of item and group keys.
 *
 * Pure: the browser page runs it on localStorage today, and the `.local/` corrections store (decision #248) runs the same
 * function in Node. Idempotent, so no "already migrated" marker is needed.
 */

type Correction = Record<string, unknown> | null;
type Task = { key?: unknown; [field: string]: unknown } | null;

export type LocalStores<C = Correction, M = unknown, W = Task> = {
  corrections: Record<string, C>;
  manual: Record<string, M[]>;
  order: Record<string, string[]>;
  work: W[];
};

export type KeyMigration<S> = {
  stores: S;
  /** True when any store changed. */
  changed: boolean;
  /** Correction keys moved to their new key (old -> new). */
  moved: Record<string, string>;
  /** Old correction keys left in place, unused, because the new key already had a correction (old -> new). */
  superseded: Record<string, string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// Usable entries only: string to different string, and no entry whose target is itself a source, so a key never moves twice.
function usableMap(legacyIds: Record<string, string>): Map<string, string> {
  const entries = Object.entries(isRecord(legacyIds) ? legacyIds : {}).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[0] !== '' && entry[1] !== '' && entry[0] !== entry[1]);
  const sources = new Set(entries.map(([from]) => from));
  return new Map(entries.filter(([, to]) => !sources.has(to)));
}

function rewrite(key: string, courseId: string, map: Map<string, string>): string {
  const groupPrefix = `${courseId}:group:${courseId}:`, itemPrefix = `${courseId}:`;
  if (key.startsWith(groupPrefix)) {
    const target = map.get(key.slice(groupPrefix.length));
    return target === undefined ? key : `${groupPrefix}${target}`;
  }
  if (key.startsWith(itemPrefix)) {
    const target = map.get(key.slice(itemPrefix.length));
    return target === undefined ? key : `${itemPrefix}${target}`;
  }
  return key;
}

/** The item or group key `key` of course `courseId` after applying `legacyIds`; other keys are returned unchanged. */
export function migrateKey(key: string, courseId: string, legacyIds: Record<string, string>): string {
  return rewrite(key, courseId, usableMap(legacyIds));
}

/**
 * Applies one course's `legacyIds` to the local stores and returns new stores (the input is never modified).
 * Correction keys are the only competing values: when the new key already has a correction, that correction wins and
 * the old one stays in place, unused (`superseded`). References (correction `parent`/`mergeInto`, manual `parent`) and
 * order entries are always rewritten; the order list is then de-duplicated, keeping the first occurrence. A planned task
 * moves to the new key unless a task already holds it, in which case it keeps its old key so no task is lost.
 */
export function migrateLocalKeys<S extends LocalStores<any, any, any>>(stores: S, courseId: string, legacyIds: Record<string, string>): KeyMigration<S> {
  const map = usableMap(legacyIds);
  const moved: Record<string, string> = {}, superseded: Record<string, string> = {};
  if (!map.size) return { stores, changed: false, moved, superseded };
  const key = (value: string) => rewrite(value, courseId, map);
  let changed = false;

  // A Map keeps any key (even `__proto__`) an ordinary entry; Object.fromEntries defines own properties.
  const entries = new Map<string, unknown>();
  for (const [name, value] of Object.entries(isRecord(stores.corrections) ? stores.corrections : {})) {
    let next = value;
    if (name.startsWith(`${courseId}:`) && isRecord(value)) {
      for (const field of ['parent', 'mergeInto']) {
        const reference = value[field];
        if (typeof reference === 'string' && key(reference) !== reference) {
          next = { ...(next as Record<string, unknown>), [field]: key(reference) };
          changed = true;
        }
      }
    }
    entries.set(name, next);
  }
  for (const name of [...entries.keys()]) {
    const target = key(name);
    if (target === name) continue;
    if (entries.has(target)) { superseded[name] = target; continue; }
    entries.set(target, entries.get(name));
    entries.delete(name);
    moved[name] = target;
    changed = true;
  }
  const corrections = Object.fromEntries(entries);

  let manual = stores.manual;
  const items = isRecord(stores.manual) ? stores.manual[courseId] : undefined;
  if (Array.isArray(items) && items.some(item => isRecord(item) && typeof item.parent === 'string' && key(item.parent) !== item.parent)) {
    manual = { ...stores.manual, [courseId]: items.map(item => (isRecord(item) && typeof item.parent === 'string' ? { ...item, parent: key(item.parent) } : item)) };
    changed = true;
  }

  let order = stores.order;
  const ranks = isRecord(stores.order) ? stores.order[courseId] : undefined;
  if (Array.isArray(ranks)) {
    const next = [...new Set(ranks.map(entry => (typeof entry === 'string' ? key(entry) : entry)))];
    if (next.length !== ranks.length || next.some((entry, index) => entry !== ranks[index])) {
      order = { ...stores.order, [courseId]: next };
      changed = true;
    }
  }

  let work = stores.work;
  if (Array.isArray(stores.work)) {
    const taken = new Set(stores.work.flatMap(task => (isRecord(task) && typeof task.key === 'string' ? [task.key] : [])));
    let workChanged = false;
    const next = stores.work.map(task => {
      if (!isRecord(task) || typeof task.key !== 'string') return task;
      const target = key(task.key);
      if (target === task.key || taken.has(target)) return task;
      taken.add(target);
      workChanged = true;
      return { ...task, key: target };
    });
    if (workChanged) { work = next; changed = true; }
  }

  return { stores: changed ? { ...stores, corrections, manual, order, work } : stores, changed, moved, superseded };
}
