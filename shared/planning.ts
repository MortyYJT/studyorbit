/** Deterministic weekly plan (decision #237): earliest deadline first, filling days forward from today. */
export type PlanTask = { key: string; due: string; minutes: number; spent?: number; done?: boolean };
export type PlanBlock = { key: string; minutes: number };
export type Overflow = { key: string; minutes: number; overdue: boolean };
export type Schedule = { days: Record<string, PlanBlock[]>; overflow: Overflow[] };

/** Available study minutes per weekday, Monday first. */
export const defaultAvailability: readonly number[] = [120, 120, 120, 120, 120, 120, 120];
const MAX_DAY = 1440;
// Only the coming year is planned; work due later is placed as the window moves forward, not reported as overflow.
const HORIZON_DAYS = 366;

/** Seven per-day minute counts; each missing or out-of-range entry falls back to the default for that day. */
export function parseAvailability(value: unknown): number[] {
  const days = Array.isArray(value) ? value : [];
  return defaultAvailability.map((fallback, index) => {
    const minutes = days[index];
    return typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 && minutes <= MAX_DAY ? minutes : fallback;
  });
}

const nextDay = (day: string) => addDays(day, 1);
const weekdayIndex = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/**
 * Place each unfinished task, in deadline order (ties by key), into the earliest days from `today` through its
 * deadline that still have capacity. For work that can be split by day this matches always working on the task
 * due soonest. Minutes that do not fit, and tasks already past their deadline, are returned as overflow.
 * Dates are `YYYY-MM-DD` strings in the owner's local calendar. Planning is in whole minutes: remaining time rounds
 * up and daily capacity rounds down. A task that is not marked done stays unfinished even when its estimate is used up,
 * so it is still reported once its deadline passes.
 */
export function schedulePlan(tasks: PlanTask[], availability: readonly number[], today: string): Schedule {
  const capacity = new Map<string, number>();
  const free = (day: string) => capacity.get(day) ?? Math.floor(availability[weekdayIndex(day)] ?? 0);
  const horizon = addDays(today, HORIZON_DAYS - 1);
  const days: Record<string, PlanBlock[]> = {};
  const overflow: Overflow[] = [];
  const open = tasks
    .filter(task => !task.done)
    .map(task => ({ task, remaining: Math.max(Math.ceil(task.minutes - (task.spent ?? 0) - 1e-9), 0) }))
    .sort((a, b) => a.task.due.localeCompare(b.task.due) || a.task.key.localeCompare(b.task.key));
  for (const { task, remaining } of open) {
    if (task.due < today) { overflow.push({ key: task.key, minutes: remaining, overdue: true }); continue; }
    let left = remaining;
    const last = task.due < horizon ? task.due : horizon;
    for (let day = today; day <= last && left > 0; day = nextDay(day)) {
      const placed = Math.min(left, free(day));
      if (placed <= 0) continue;
      (days[day] ??= []).push({ key: task.key, minutes: placed });
      capacity.set(day, free(day) - placed);
      left -= placed;
    }
    if (left > 0 && task.due <= horizon) overflow.push({ key: task.key, minutes: left, overdue: false });
  }
  return { days, overflow };
}
