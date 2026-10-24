import type { Output } from './client.js';
import type { Attention } from './shell.js';
export type PlanPage = Output<'plan.read'>;
export type Plan = Omit<PlanPage, 'nextCursor' | 'textContinuations'>;
export type Course = Output<'courses.list'>['items'][number];
export type Assessment = Output<'assessments.list'>['items'][number];
export type Task = Output<'tasks.list'>['items'][number];
export type Confirmation = Output<'confirmation.list'>['items'][number];
export type Work = Plan['work'][number];
export interface DeadlineEntry { id: string; title: string; courseCode?: string; kind: 'due' | 'exam' | 'all-day'; time?: string; done: boolean; manual: boolean }
export interface PlannedItem { workId: string; title: string; courseCode?: string; minutes: number; startTime?: string; estimateMinutes?: number; actualMinutes: number; manual: boolean }
export interface WorkRow { workId: string; title: string; courseCode?: string; minutes?: number; due?: string; estimateMinutes?: number; manual: boolean }
export interface DayColumn { date: string; availableMinutes?: number; usedMinutes: number; deadlines: DeadlineEntry[]; items: PlannedItem[] }
export type Need = { kind: 'confirm'; id: string; assessmentId: string; courseId?: string; summary: string }
  | Attention | { kind: 'overflow'; workId: string; title: string; courseCode?: string; minutes: number }
  | { kind: 'unestimated'; count: number };
export interface CourseSummary { id: string; code: string; name: string; gradedWeight: number; unknownWeight: boolean; next?: { title: string; due: string }; undatedExams: string[] }
export interface MonthCell { date: string; inMonth: boolean; deadlines: DeadlineEntry[] }

/** Calendar arithmetic uses UTC noon only as a representation of local dates. */
export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function mondayOf(date: string): string { return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7)); }
function parts(instant: Date | string, timeZone: string) {
  const values = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instant));
  return Object.fromEntries(values.map(part => [part.type, part.value])) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}
export function localDate(instant: Date | string, timeZone: string): string { const p = parts(instant, timeZone); return `${p.year}-${p.month}-${p.day}`; }
export function localTime(instant: Date | string, timeZone: string): string { const p = parts(instant, timeZone); return `${p.hour}:${p.minute}`; }
function offsetMinutes(utc: number, timeZone: string): number {
  const p = parts(new Date(utc), timeZone);
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utc) / 60000;
}
/** Local wall-clock date and time in `timeZone` as an ISO instant with its offset. */
export function zonedIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let offset = offsetMinutes(wall, timeZone);
  offset = offsetMinutes(wall - offset * 60000, timeZone);
  const sign = offset < 0 ? '-' : '+'; const abs = Math.abs(offset);
  return `${date}T${time}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
/** The term with the most courses; ties go to the later term name. */
export function pickTerm(courses: readonly Pick<Course, 'term'>[]): string | undefined {
  const counts = new Map<string, number>();
  for (const course of courses) counts.set(course.term, (counts.get(course.term) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))[0]?.[0];
}
export function mergePlanPages(pages: readonly PlanPage[]): Plan {
  const plan: Plan = { days: [], work: [], overflow: [], unestimated: [], deadlines: [] };
  const continuations: NonNullable<PlanPage['textContinuations']> = [];
  for (const { nextCursor: _cursor, textContinuations, settings, ...page } of pages) {
    if (settings) plan.settings = settings;
    plan.work.push(...page.work.map(item => structuredClone(item))); plan.deadlines.push(...page.deadlines.map(item => ({ ...item })));
    plan.overflow.push(...page.overflow); plan.unestimated.push(...page.unestimated);
    continuations.push(...textContinuations ?? []);
    for (const day of page.days) {
      const previous = plan.days.at(-1);
      if (previous?.date === day.date) previous.items.push(...day.items); else plan.days.push({ ...day, items: [...day.items] });
    }
  }
  const insert = (value: string, offset: number, text: string) => value.slice(0, offset) + text + value.slice(offset);
  for (const part of continuations) {
    const row = (part.collection === 'work' ? plan.work : plan.deadlines).find(item => item.workId === part.workId);
    if (!row) continue;
    if (part.field === 'title') row.title = insert(row.title, part.offset, part.text);
    else if ('agentEstimate' in row && row.agentEstimate?.reason !== undefined) row.agentEstimate.reason = insert(row.agentEstimate.reason, part.offset, part.text);
  }
  return plan;
}
/** Timed items by start time, then untimed items in plan order. */
export function orderDayItems<T extends { startTime?: string }>(items: readonly T[]): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => a.item.startTime && b.item.startTime
    ? a.item.startTime.localeCompare(b.item.startTime) || a.index - b.index : a.item.startTime ? -1 : b.item.startTime ? 1 : a.index - b.index).map(({ item }) => item);
}
/** Effective annotated value when the read carries one; `null` means the value is unknown. */
export function field<K extends 'name' | 'due' | 'weight' | 'kind' | 'score'>(assessment: Assessment, key: K): Assessment[K] | undefined {
  const value = assessment.fields && key in assessment.fields ? assessment.fields[key]!.value : assessment[key];
  return value === null ? undefined : value as Assessment[K];
}
/** No read exposes linked platform facts, but the plan drops assessments whose platform items are submitted
 * or removed (`src/planning/work.ts`): a term assessment missing from plan work (or, for exams, from plan
 * deadlines within the plan's dates) is closed. Without a plan only the stored status counts. */
export function isClosed(assessment: Assessment, plan: Plan | undefined, timeZone: string): boolean {
  if (assessment.status === 'submitted' || assessment.status === 'graded') return true;
  if (!plan) return false;
  if (field(assessment, 'kind') !== 'exam') return !plan.work.some(item => item.workId === assessment.id);
  if (plan.deadlines.some(item => item.workId === assessment.id)) return false;
  const due = field(assessment, 'due'); const first = plan.days[0]?.date;
  // Plan deadlines omit exams dated before the plan starts; those stay open unless their status says otherwise.
  return !(due && first && localDate(due, timeZone) < first);
}
export function deadlinesByDate(input: { plan?: Plan; courses: readonly Course[]; assessments: readonly Assessment[]; tasks: readonly Task[]; timeZone: string }): Map<string, DeadlineEntry[]> {
  const codes = new Map(input.courses.map(course => [course.id, course.code]));
  const result = new Map<string, DeadlineEntry[]>();
  const add = (due: string, entry: DeadlineEntry) => {
    const date = localDate(due, input.timeZone);
    result.set(date, [...result.get(date) ?? [], entry]);
  };
  for (const assessment of input.assessments) {
    const due = field(assessment, 'due'); const title = field(assessment, 'name');
    if (!due || title === undefined || !codes.has(assessment.courseId)) continue;
    add(due, { id: assessment.id, title, courseCode: codes.get(assessment.courseId), kind: field(assessment, 'kind') === 'exam' ? 'exam' : 'due',
      time: localTime(due, input.timeZone), done: isClosed(assessment, input.plan, input.timeZone), manual: false });
  }
  for (const task of input.tasks) {
    if (task.source !== 'manual' || !task.due || task.done) continue;
    add(task.due, { id: task.id, title: task.title, kind: task.allDay ? 'all-day' : 'due', ...(task.allDay ? {} : { time: localTime(task.due, input.timeZone) }), done: false, manual: true });
  }
  for (const entries of result.values()) entries.sort((a, b) => (a.kind === 'all-day' ? '' : a.time ?? '').localeCompare(b.kind === 'all-day' ? '' : b.time ?? '') || a.id.localeCompare(b.id));
  return result;
}
export function weekModel(input: { plan?: Plan; courses: readonly Course[]; assessments: readonly Assessment[]; tasks: readonly Task[]; monday: string; timeZone: string }) {
  const codes = new Map(input.courses.map(course => [course.id, course.code]));
  const manual = new Set(input.tasks.filter(task => task.source === 'manual').map(task => task.id));
  const work = new Map((input.plan?.work ?? []).map(item => [item.workId, item]));
  const describe = (workId: string) => {
    const item = work.get(workId);
    return { workId, title: item?.title ?? workId, courseCode: item?.courseId ? codes.get(item.courseId) : undefined, estimateMinutes: item?.estimateMinutes,
      actualMinutes: item?.actualMinutes ?? 0, due: item?.due, manual: manual.has(workId) };
  };
  const deadlines = deadlinesByDate(input);
  const plannedDays = new Map((input.plan?.days ?? []).map(day => [day.date, day]));
  const days: DayColumn[] = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(input.monday, index); const day = plannedDays.get(date);
    const items = orderDayItems((day?.items ?? []).map(item => { const { due: _due, ...rest } = describe(item.workId); return { ...rest, minutes: item.minutes, ...(item.startTime ? { startTime: item.startTime } : {}) }; }));
    const configured = input.plan?.settings?.weekdayMinutes[index];
    return { date, availableMinutes: day?.availableMinutes ?? configured, usedMinutes: items.reduce((sum, item) => sum + item.minutes, 0), deadlines: deadlines.get(date) ?? [], items };
  });
  const row = (workId: string, minutes?: number): WorkRow => { const { actualMinutes: _actual, ...rest } = describe(workId); return { ...rest, ...(minutes !== undefined ? { minutes } : {}) }; };
  return { days, overflow: (input.plan?.overflow ?? []).map(item => row(item.workId, item.minutes)), unestimated: (input.plan?.unestimated ?? []).map(item => row(item.workId)) };
}
export function needsYou(input: { attention: readonly Attention[];confirmations: readonly Confirmation[]; overflow: readonly WorkRow[]; unestimated: readonly WorkRow[];
  assessments?: readonly { id: string; courseId: string }[] }): Need[] {
  const courseOf = new Map((input.assessments ?? []).map(item => [item.id, item.courseId]));
  return [
    ...input.confirmations.filter(row => row.state === 'pending').map(row => ({ kind: 'confirm' as const, id: row.id, assessmentId: row.assessmentId, courseId: courseOf.get(row.assessmentId), summary: row.summary })),
    ...input.attention.map(item => 'site' in item ? { kind: item.kind, site: item.site } as Attention : item),
    ...input.overflow.map(item => ({ kind: 'overflow' as const, workId: item.workId, title: item.title, courseCode: item.courseCode, minutes: item.minutes ?? 0 })),
    ...input.unestimated.length ? [{ kind: 'unestimated' as const, count: input.unestimated.length }] : [],
  ];
}
export function courseSummaries(courses: readonly Course[], assessments: readonly Assessment[], now: Date, plan?: Plan): CourseSummary[] {
  const timeZone = plan?.settings?.timeZone ?? 'UTC';
  return courses.map(course => {
    const own = assessments.filter(item => item.courseId === course.id && field(item, 'name') !== undefined);
    // Same rule as the domain grade projection: graded means an effective score and weight are both known.
    const gradedWeight = own.filter(item => field(item, 'score') !== undefined).reduce((sum, item) => sum + (field(item, 'weight') ?? 0), 0);
    const open = own.filter(item => !isClosed(item, plan, timeZone));
    const undatedExams = open.filter(item => field(item, 'kind') === 'exam' && !field(item, 'due')).map(item => field(item, 'name')!);
    const next = open
      .flatMap(item => { const due = field(item, 'due'); return due && Date.parse(due) >= now.getTime() ? [{ title: field(item, 'name')!, due }] : []; })
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))[0];
    return { id: course.id, code: course.code, name: course.name, gradedWeight, unknownWeight: !own.length || own.some(item => field(item, 'weight') === undefined), ...(next ? { next } : {}), undatedExams };
  });
}
export function monthGrid(date: string, deadlines: ReadonlyMap<string, DeadlineEntry[]>): MonthCell[][] {
  const month = date.slice(0, 7); const first = `${month}-01`;
  const weeks: MonthCell[][] = [];
  for (let start = mondayOf(first); start.slice(0, 7) <= month; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => { const day = addDays(start, index); return { date: day, inMonth: day.slice(0, 7) === month, deadlines: deadlines.get(day) ?? [] }; }));
  }
  return weeks;
}
