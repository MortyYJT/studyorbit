import { z } from 'zod';
import { COURSE_ID, sameValue } from './corrections.ts';
import { toDisplayDocument, type CourseDocument, type DisplayDocument } from './course-data.ts';

/**
 * Course change log (openspec change local-corrections-merge, design §8, decision #296): due date and weight changes
 * between two successive documents of one course, paired by stable ID. Scores are never part of a change.
 */
export type CourseChangeEntry =
  | { assessmentId: string; name: string; field: 'due'; before: string | null; after: string | null }
  | { assessmentId: string; name: string; field: 'weight'; before: number | null; after: number | null };

/**
 * Due and weight changes from `previous` to `current` (either version, through the display conversion). A previous
 * assessment is paired with the current assessment of the same ID, otherwise with `current.legacyIds[previousId]` when
 * that assessment exists; a current assessment is paired at most once (same-ID pairs first). Values are compared with
 * the merge's `sameValue` (due instants, weights to two decimals, a value becoming or ceasing to be null is a change).
 * Unpaired assessments are not reported. Output follows current document order, `due` before `weight`, with the
 * current name. A date-only due compares with a date-time by day in `timeZone` (the institution's). Pure; never
 * modifies the inputs.
 */
export function diffSnapshots(previous: CourseDocument | DisplayDocument, current: CourseDocument | DisplayDocument, timeZone: string): CourseChangeEntry[] {
  const before = toDisplayDocument(previous).assessments, after = toDisplayDocument(current);
  const currentIds = new Set(after.assessments.map(item => item.id));
  // Maps, not objects, so an ID such as `__proto__` stays an ordinary key.
  const legacy = new Map(Object.entries(after.legacyIds));
  const pairs = new Map<string, (typeof before)[number]>();
  for (const item of before) if (currentIds.has(item.id)) pairs.set(item.id, item);
  for (const item of before) {
    if (currentIds.has(item.id)) continue;
    const target = legacy.get(item.id);
    if (target !== undefined && currentIds.has(target) && !pairs.has(target)) pairs.set(target, item);
  }
  return after.assessments.flatMap(item => {
    const old = pairs.get(item.id);
    if (!old) return [];
    const changes: CourseChangeEntry[] = [];
    if (!sameValue('due', old.due, item.due, timeZone)) changes.push({ assessmentId: item.id, name: item.name, field: 'due', before: old.due, after: item.due });
    if (!sameValue('weight', old.weight, item.weight, timeZone)) changes.push({ assessmentId: item.id, name: item.name, field: 'weight', before: old.weight, after: item.weight });
    return changes;
  });
}

const isoTime = z.string().refine(value => Number.isFinite(Date.parse(value)), 'must be a date-time');
const lineBase = { at: isoTime, runId: z.string().min(1).max(200), courseId: z.string().regex(COURSE_ID), assessmentId: z.string().min(1).max(500), name: z.string() };
/** One line of `.local/lms/changes.jsonl`: `{ at, runId, courseId, assessmentId, name, field, before, after }`. */
export const CourseChangeSchema = z.discriminatedUnion('field', [
  z.object({ ...lineBase, field: z.literal('due'), before: z.string().nullable(), after: z.string().nullable() }),
  z.object({ ...lineBase, field: z.literal('weight'), before: z.number().nullable(), after: z.number().nullable() }),
]);
export type CourseChange = z.infer<typeof CourseChangeSchema>;

/** localStorage key of the newest change time the owner dismissed with 「知道了」 (an ISO time; absent = nothing seen). */
export const CHANGES_SEEN_KEY = 'coursework.course-changes-seen.v1';

const time = (value: string | null | undefined) => (value ? Date.parse(value) : NaN);

/**
 * Changes later than the seen marker (an unreadable marker counts as absent) of courses in `courseIds`, for display:
 * newest `at` first, and lines of one time in the order they were logged (document order). `changes` is the API's
 * newest-first list, so within one time a later index was logged earlier.
 */
export function unseenChanges(changes: readonly CourseChange[], seen: string | null, courseIds: readonly string[]): CourseChange[] {
  const marker = time(seen), courses = new Set(courseIds);
  return changes.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => courses.has(entry.courseId) && !(Number.isFinite(marker) && time(entry.at) <= marker))
    .sort((a, b) => (time(b.entry.at) - time(a.entry.at)) || (b.index - a.index))
    .map(({ entry }) => entry);
}

/** The newest `at` among changes, or null for none. */
export function newestAt(changes: readonly CourseChange[]): string | null {
  return changes.reduce<string | null>((newest, entry) => (newest === null || time(entry.at) > time(newest) ? entry.at : newest), null);
}

/**
 * The marker 「知道了」 on one course page sets: the newest `at` of that course's unseen changes, or null when the
 * course has none or when the single marker would also hide another course's unseen change (decision #411).
 */
export function courseDismissAt(unseen: readonly CourseChange[], courseId: string): string | null {
  const at = newestAt(unseen.filter(entry => entry.courseId === courseId));
  if (at === null) return null;
  return unseen.some(entry => entry.courseId !== courseId && time(entry.at) <= time(at)) ? null : at;
}
