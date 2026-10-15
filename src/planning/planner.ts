import type { PlanningSettings } from '../domain/schemas.js';
import { localDate, type WorkItem } from './work.js';
import { PlanningSettingsSchema } from '../domain/schemas.js';
import { z } from 'zod';
export interface PlanInput { settings: PlanningSettings; startDate: string; horizonDays: number; items: readonly WorkItem[] }
export interface DayPlan { date: string; availableMinutes: number; items: { workId: string; minutes: number }[] }
/** Calendar arithmetic deliberately uses UTC only as a representation of local dates. */
export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function planDays(input: PlanInput): { days: DayPlan[]; overflow: { workId: string; minutes: number }[]; unestimated: WorkItem[] } {
  const settings = PlanningSettingsSchema.parse(input.settings);
  z.iso.date().parse(input.startDate); z.number().int().min(1).max(366).parse(input.horizonDays);
  const days = Array.from({ length: input.horizonDays }, (_, index): DayPlan => {
    const date = addDays(input.startDate, index);
    const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
    return { date, availableMinutes: settings.weekdayMinutes[weekday]!, items: [] };
  });
  const remaining = days.map(day => day.availableMinutes);
  const ordered = [...input.items].sort((a, b) => {
    const dueA = a.due ? Date.parse(a.due) : Infinity; const dueB = b.due ? Date.parse(b.due) : Infinity;
    return (dueA < dueB ? -1 : dueA > dueB ? 1 : 0) || (a.workId < b.workId ? -1 : a.workId > b.workId ? 1 : 0);
  });
  const overflow: { workId: string; minutes: number }[] = []; const unestimated: WorkItem[] = [];
  for (const item of ordered) {
    if (item.estimateMinutes === undefined) { unestimated.push({ ...item }); continue; }
    z.number().nonnegative().finite().parse(item.estimateMinutes);
    let missing = item.estimateMinutes;
    const dueDate = item.due ? localDate(item.due, settings.timeZone) : days.at(-1)!.date;
    // Overdue work remains first across the horizon, including when it splits across days.
    const lastDate = dueDate < input.startDate ? days.at(-1)!.date : dueDate;
    for (const [index, day] of days.entries()) {
      if (!missing || day.date > lastDate) break;
      const minutes = Math.min(missing, remaining[index]!);
      if (minutes > 0) day.items.push({ workId: item.workId, minutes });
      remaining[index]! -= minutes; missing -= minutes;
    }
    if (missing > 0) overflow.push({ workId: item.workId, minutes: missing });
  }
  return { days, overflow, unestimated };
}
