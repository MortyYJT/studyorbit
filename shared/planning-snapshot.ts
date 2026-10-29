// Planning snapshot sent with each Agent chat message (decision #322). Tasks, availability and target bands live in
// browser localStorage (#290), so the page builds the snapshot and the server validates it. Pure module: no I/O.
import { z } from 'zod';
import { bandTargets, type Band } from './course-calculations.ts';
import type { PlanningSnapshot } from './course-tools.ts';

/** Most tasks sent with one message. */
export const SNAPSHOT_TASK_LIMIT = 500;
const TITLE_LIMIT = 200;
const MINUTES_LIMIT = 100000;

/** A snapshot plus the number of unfinished tasks left out because of the task limit. */
export type SentPlanning = PlanningSnapshot & { omitted?: number };
type Work = { key: string; courseId: string; courseCode: string; title: string; due: string; minutes: number; spent?: number; done?: boolean };

/**
 * The weekly page's own task set (every task of the loaded courses plus personal tasks), unfinished only, with the
 * page's keys. More than 500 are cut in schedulePlan order (due, then key): earliest-deadline-first never lets a later
 * task move an earlier one, so the plan of the tasks sent is unchanged.
 */
export function buildPlanningSnapshot({ work, availability, targets, courseIds }: { work: Work[]; availability: number[]; targets: Record<string, Band>; courseIds: string[] }): SentPlanning {
  const open = work
    .filter(task => !task.done && (task.courseId === '' || courseIds.includes(task.courseId)))
    .filter(task => task.key.length <= 500 && task.courseId.length <= 200)
    .sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key));
  const tasks = open.slice(0, SNAPSHOT_TASK_LIMIT).map(task => ({
    key: task.key, title: task.title.slice(0, TITLE_LIMIT), courseId: task.courseId, courseCode: task.courseCode.slice(0, 200),
    due: task.due, minutes: Math.min(task.minutes, MINUTES_LIMIT), ...(task.spent !== undefined ? { spent: task.spent } : {}),
  }));
  return {
    tasks, availability: [...availability],
    targets: Object.fromEntries(Object.entries(targets).filter(([id]) => courseIds.includes(id))),
    ...(open.length > SNAPSHOT_TASK_LIMIT ? { omitted: open.length - SNAPSHOT_TASK_LIMIT } : {}),
  };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value));
const SnapshotSchema = z.strictObject({
  tasks: z.array(z.strictObject({
    key: z.string().min(1).max(500), title: z.string().max(TITLE_LIMIT), courseId: z.string().max(200), courseCode: z.string().max(200),
    due: date, minutes: z.number().gt(0).max(MINUTES_LIMIT), spent: z.number().min(0).optional(), done: z.boolean().optional(),
  })).max(SNAPSHOT_TASK_LIMIT),
  availability: z.array(z.number().min(0).max(1440)).length(7),
  targets: z.record(z.string().min(1).max(200), z.enum(Object.keys(bandTargets) as [Band, ...Band[]])).refine(value => Object.keys(value).length <= 200),
  omitted: z.number().int().nonnegative().optional(),
});

/** Strict server-side check. A missing snapshot means no planning data; anything invalid is refused as a whole. */
export function parsePlanningSnapshot(value: unknown): { ok: true; planning: SentPlanning | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, planning: null };
  const parsed = SnapshotSchema.safeParse(value);
  return parsed.success ? { ok: true, planning: parsed.data } : { ok: false };
}
