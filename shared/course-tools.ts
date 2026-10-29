// Read-only course tools shared by the Agent chat, the Q&A runner and the MCP server (decision #320).
// Pure module: no I/O, no clock reads, no network. Every call sees the documents and date in its ToolContext.
// Tools read synced documents only; owner corrections are not applied (#297, #321).
import { z } from 'zod';
import { bandTargets, calculateGrades, finalNeeded, gradeBreakdown, type Band, type ExclusionReason, type GradingGroup, type GradingItem } from './course-calculations.ts';
import type { DisplayAssessment, DisplayDocument } from './course-data.ts';
import { defaultAvailability, parseAvailability, schedulePlan, type PlanTask } from './planning.ts';
import { DEFAULT_INSTITUTION } from '../scripts/institutions/registry.mjs';

/** Planning inputs the page keeps in localStorage, sent with a chat message (decision #322). */
export type PlanningSnapshot = {
  /** The weekly page's own task set and keys; done tasks are normally left out. */
  tasks: { key: string; title: string; courseId: string; courseCode: string; due: string; minutes: number; spent?: number; done?: boolean }[];
  /** Seven values, Monday first. */
  availability: number[];
  /** Course ID -> saved target band. */
  targets: Record<string, Band>;
};
export type ToolContext = {
  /** Synced documents already passed through toDisplayDocument. */
  documents: DisplayDocument[];
  /** Known courses, used to name scope courses that have no document. */
  courses: { id: string; code?: string; name?: string }[];
  /** Course IDs the tools may read. */
  scope: string[];
  /** YYYY-MM-DD in the institution's time zone. */
  today: string;
  planning: PlanningSnapshot | null;
  /** The institution's IANA time zone, for due dates; default the default institution's (generic-adapters §4). */
  timeZone?: string;
};
export type ToolErrorCode = 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'COURSE_NOT_IN_SCOPE' | 'COURSE_NOT_SYNCED' | 'UNKNOWN_ASSESSMENT' | 'RESULT_TOO_LARGE' | 'TOOL_FAILED';
export type ToolResult = { ok: boolean; text: string; value: object };
type Failure = { error: { code: ToolErrorCode; message: string } };
type Output = { value: Record<string, unknown>; hint?: string };
export type CourseTool = {
  name: string; title: string; description: string; input: z.ZodObject;
  run(input: never, ctx: ToolContext): Output | Failure;
};

/** Largest serialised tool result, in characters. */
export const RESULT_LIMIT = 8000;
const UPCOMING_LIMIT = 50;
const NOT_AVAILABLE = 'Planning tasks live in the StudyOrbit page and were not provided; pass tasks to plan with them.';

const fail = (code: ToolErrorCode, message: string): Failure => ({ error: { code, message } });
const isFailure = (value: unknown): value is Failure => typeof value === 'object' && value !== null && 'error' in value;

type GradingInput = GradingItem & { parent: string | null; scoring: DisplayAssessment['scoring'] };
/**
 * Grading inputs built from an uncorrected document the same way the course page builds them: alternative items are
 * left out, and so are children of a bonus, alternative, ungraded or zero-weight parent; every other parent with
 * children becomes a group.
 */
export function gradingInputs(doc: DisplayDocument): { assessments: GradingInput[]; parents: GradingGroup[] } {
  const items: GradingInput[] = doc.assessments.map(item => ({
    key: item.id, parent: item.parentId, weightValue: item.weight ?? undefined, score: item.score ?? undefined, outOf: item.maxScore ?? undefined,
    bonus: item.nature === 'bonus', ungraded: item.nature === 'ungraded', caution: item.nature === 'alternative', sourceZero: item.weight === 0,
    kind: item.kind === 'test' ? 'exam' : item.kind === 'other' ? 'unknown' : item.kind, scoring: item.scoring,
  }));
  const excluded = (source: GradingInput) => source.bonus || source.caution || source.ungraded || source.sourceZero;
  const assessments = items.filter(item => {
    const source = item.parent ? items.find(parent => parent.key === item.parent) : undefined;
    return !item.caution && !(source && excluded(source));
  });
  const parents = items.flatMap(source => {
    const children = items.filter(item => item.parent === source.key && !item.caution);
    return children.length && !excluded(source) ? [{ weight: source.weightValue, score: source.score, outOf: source.outOf, children, scoringRule: source.scoring ?? 'none', sourceKey: source.key }] : [];
  });
  return { assessments, parents };
}

const DEFAULT_TIME_ZONE = DEFAULT_INSTITUTION.defaults.timeZone!;
const zoneOf = (ctx: ToolContext) => ctx.timeZone ?? DEFAULT_TIME_ZONE;

/** Due date as `YYYY-MM-DD HH:mm` in `timeZone`, a plain date unchanged, or the stored text when unparseable. */
export function formatDue(due: string | null, timeZone: string): string | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return due;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Sum of top-level weights that count, as on the course page's weight breakdown. */
function identifiedWeight(doc: DisplayDocument): number {
  return doc.assessments.filter(item => item.parentId === null && item.nature === 'regular' && item.weight !== null && item.weight > 0).reduce((sum, item) => sum + item.weight!, 0);
}

function scopeFailure(ctx: ToolContext, id: string): Failure {
  const allowed = ctx.scope.map(scopeId => { const code = ctx.documents.find(doc => doc.course.id === scopeId)?.course.code ?? ctx.courses.find(entry => entry.id === scopeId)?.code; return code ? `${scopeId} (${code})` : scopeId; });
  return fail('COURSE_NOT_IN_SCOPE', `Course ${id} is not available here. Allowed course IDs: ${allowed.join(', ') || 'none'}. Call list_courses to see them.`);
}

function findCourse(ctx: ToolContext, id: string): DisplayDocument | Failure {
  if (!ctx.scope.includes(id)) return scopeFailure(ctx, id);
  const doc = ctx.documents.find(entry => entry.course.id === id);
  return doc ?? fail('COURSE_NOT_SYNCED', `Course ${id} has no synced data yet, so its assessments are unknown. Say so instead of guessing.`);
}

const courseId = z.string().min(1).describe('Course ID from list_courses');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'Not a real date');
const whatIf = z.array(z.object({
  assessmentId: z.string().min(1).describe('Assessment ID from get_assessments'),
  percent: z.number().min(0).max(100).describe('Hypothetical mark as a percentage of the maximum score'),
})).max(20).optional().describe('Hypothetical marks applied to a copy of the data only; nothing is saved');
const bands = Object.keys(bandTargets) as [Band, ...Band[]];

type WhatIf = { assessmentId: string; percent: number }[] | undefined;
type Applied = { assessmentId: string; percent: number; effect: 'counted' | 'none'; reason?: string };
type Graded = {
  doc: DisplayDocument; totals: ReturnType<typeof calculateGrades>;
  counted: { id: string; name: string; weight: number; earned: number }[];
  excluded: { id: string; name: string; reason: ExclusionReason }[];
  whatIfApplied: Applied[];
};

const ownScore = (item: DisplayAssessment) => item.weight !== null && item.weight > 0 && item.score !== null && item.maxScore !== null && item.maxScore > 0 && item.score <= item.maxScore;

/** Grades a course after applying hypothetical marks to a copy, with counted and excluded items in document order. */
function grade(original: DisplayDocument, entries: WhatIf): Graded | Failure {
  const byId = new Map(original.assessments.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const [index, entry] of (entries ?? []).entries()) {
    const target = byId.get(entry.assessmentId);
    if (!target) return fail('UNKNOWN_ASSESSMENT', `whatIf.${index}.assessmentId: ${entry.assessmentId} is not an assessment of ${original.course.id}. Call get_assessments for the IDs.`);
    if (target.nature !== 'regular') return fail('INVALID_ARGUMENTS', `whatIf.${index}.assessmentId: ${entry.assessmentId} is a ${target.nature} item and never counts towards the total.`);
    if (seen.has(entry.assessmentId)) return fail('INVALID_ARGUMENTS', `whatIf.${index}.assessmentId: ${entry.assessmentId} appears more than once.`);
    seen.add(entry.assessmentId);
  }
  const marks = new Map((entries ?? []).map(entry => [entry.assessmentId, entry.percent]));
  const doc: DisplayDocument = { ...original, assessments: original.assessments.map(item => {
    const percent = marks.get(item.id);
    if (percent === undefined) return item;
    return item.maxScore !== null && item.maxScore > 0 ? { ...item, score: percent / 100 * item.maxScore } : { ...item, score: percent, maxScore: 100 };
  }) };
  const { assessments, parents } = gradingInputs(doc);
  const breakdown = gradeBreakdown(assessments, parents);
  const totals = calculateGrades(assessments, parents);
  const countedMap = new Map(breakdown.counted.map(entry => [entry.key, entry]));
  const reasons = new Map(breakdown.excluded.map(entry => [entry.key, entry.reason]));
  const current = new Map(doc.assessments.map(item => [item.id, item]));
  // Items the grading inputs leave out: alternatives, and children of a parent that never counts.
  const leftOut = (item: DisplayAssessment): ExclusionReason | undefined => {
    if (item.nature === 'alternative') return 'alternative';
    const parent = item.parentId ? current.get(item.parentId) : undefined;
    if (!parent) return undefined;
    return parent.nature === 'bonus' ? 'bonus' : parent.nature === 'ungraded' ? 'ungraded' : parent.nature === 'alternative' ? 'alternative' : parent.weight === 0 ? 'zero-weight' : undefined;
  };
  const reasonOf = (item: DisplayAssessment) => reasons.get(item.id) ?? (assessments.some(entry => entry.key === item.id) ? undefined : leftOut(item));
  const counted: Graded['counted'] = [];
  const excluded: Graded['excluded'] = [];
  for (const item of doc.assessments) {
    const entry = countedMap.get(item.id);
    if (entry) { counted.push({ id: item.id, name: item.name, weight: entry.weight, earned: entry.earned }); continue; }
    const reason = reasonOf(item);
    if (reason) excluded.push({ id: item.id, name: item.name, reason });
  }
  const whatIfApplied = (entries ?? []).map(({ assessmentId, percent }): Applied => {
    const item = current.get(assessmentId)!;
    const parent = item.parentId ? current.get(item.parentId) : undefined;
    const none = (reason: string): Applied => ({ assessmentId, percent, effect: 'none', reason });
    if (countedMap.has(item.id)) return { assessmentId, percent, effect: 'counted' };
    // The item's own exclusion comes first: a counted group still drops its zero-weight children.
    const reason = reasonOf(item);
    if (reason === 'bonus' || reason === 'ungraded' || reason === 'alternative' || reason === 'zero-weight') return none(reason);
    if (parent && countedMap.has(parent.id)) return ownScore(parent) ? none('parent-score-overrides') : { assessmentId, percent, effect: 'counted' };
    if (parent) return none(parent.weight === null && item.weight === null ? 'no-weight' : 'group-incomplete');
    if (item.weight === null) return none('no-weight');
    return none(reason ?? 'group-incomplete');
  });
  return { doc: original, totals, counted, excluded, whatIfApplied };
}

// Tool descriptions name the institution's time zone with its English time label (`label`); for the default institution
// they are the descriptions the chat Q&A evaluation was run with.
const listCourses = (label: string): CourseTool => ({
  name: 'list_courses', title: 'List courses',
  description: `List the courses you may read, with today's date (${label}), whether synced data exists, the number of assessments and the identified weight (sum of top-level weights that count). Call this first to get course IDs.`,
  input: z.object({}),
  run: (_input: Record<string, never>, ctx) => ({ value: {
    today: ctx.today,
    courses: ctx.scope.map(id => {
      const doc = ctx.documents.find(entry => entry.course.id === id);
      if (doc) return { id, code: doc.course.code, name: doc.course.name, term: doc.course.term, synced: true, version: doc.version, assessmentCount: doc.assessments.length, identifiedWeight: identifiedWeight(doc) };
      const known = ctx.courses.find(entry => entry.id === id);
      return { id, code: known?.code ?? null, name: known?.name ?? null, term: null, synced: false, version: null, assessmentCount: null, identifiedWeight: null };
    }),
  } }),
});

const kinds = ['quiz', 'assignment', 'test', 'presentation', 'participation', 'hurdle', 'other'] as const;
const getAssessments = (label: string): CourseTool => ({
  name: 'get_assessments', title: 'Get assessments',
  description: `Return a course's assessments as stored: ID, parent ID, name, kind, nature (regular, ungraded, bonus, alternative), weight (% of the course total), score and maximum score (raw points), due date in ${label} time, status, scoring rule of a parent and rule text. A weight or rule with no source is null and flagged weightUnsourced or ruleUnsourced: say there is no source instead of guessing.`,
  input: z.object({
    courseId,
    ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('Only these assessment IDs'),
    kind: z.enum(kinds).optional().describe('Only this kind'),
  }),
  run: (input: { courseId: string; ids?: string[]; kind?: (typeof kinds)[number] }, ctx) => {
    const doc = findCourse(ctx, input.courseId);
    if (isFailure(doc)) return doc;
    const missing = (input.ids ?? []).filter(id => !doc.assessments.some(item => item.id === id));
    if (missing.length) return fail('UNKNOWN_ASSESSMENT', `No assessment with ID ${missing.join(', ')} in ${doc.course.id}. Call get_assessments without ids to list them.`);
    const assessments = doc.assessments.filter(item => (!input.ids || input.ids.includes(item.id)) && (!input.kind || item.kind === input.kind)).map(item => ({
      id: item.id, parentId: item.parentId, name: item.name, kind: item.kind, nature: item.nature,
      weight: item.weight, ...(item.unsourced.includes('weight') ? { weightUnsourced: true } : {}),
      score: item.score, maxScore: item.maxScore, due: formatDue(item.due, zoneOf(ctx)), status: item.status, scoring: item.scoring,
      rule: item.rule === null ? null : item.rule.replace(/\s+/g, ' ').trim(), ...(item.unsourced.includes('rule') ? { ruleUnsourced: true } : {}),
    }));
    return { value: { courseId: doc.course.id, code: doc.course.code, assessments }, hint: 'Pass ids or kind to get the rest.' };
  },
});

const calculateGradesTool: CourseTool = {
  name: 'calculate_grades', title: 'Calculate grades',
  description: 'Compute a course\'s graded weight, earned points (out of 100), average on the graded part and remaining weight with the same rules as the course page. Lists each counted item with its earned points and each excluded item with a reason (bonus, ungraded, alternative, zero-weight, no-weight, no-mark, incomplete-group). Optional whatIf applies hypothetical marks to a copy only; every entry is reported in whatIfApplied, and an entry with effect none cannot change the total (mention it and its reason).',
  input: z.object({ courseId, whatIf }),
  run: (input: { courseId: string; whatIf?: WhatIf }, ctx) => {
    const doc = findCourse(ctx, input.courseId);
    if (isFailure(doc)) return doc;
    const result = grade(doc, input.whatIf);
    if (isFailure(result)) return result;
    return { value: {
      courseId: doc.course.id, code: doc.course.code, gradedWeight: result.totals.weight, earned: result.totals.earned, average: result.totals.average ?? null,
      remainingWeight: 100 - result.totals.weight, identifiedWeight: identifiedWeight(doc), counted: result.counted, excluded: result.excluded, whatIfApplied: result.whatIfApplied,
    }, hint: 'Ask about fewer what-if items, or use get_assessments for single items.' };
  },
};

const finalNeededTool: CourseTool = {
  name: 'final_needed', title: 'Final needed',
  description: 'Average still needed across all weight without a mark (100 minus graded weight, so unidentified weight counts as remaining) to reach a target. Target is a band (H1 80, H2A 75, H2B 70, H3 65, P 50) or a percentage; without one, the band saved on the course page is used, else H1. Status is secured, reachable (with neededAverage) or unreachable. Accepts the same whatIf list as calculate_grades.',
  input: z.object({
    courseId,
    target: z.union([z.enum(bands), z.number().min(0).max(100)]).optional().describe('Band name or percentage of the course total'),
    whatIf,
  }),
  run: (input: { courseId: string; target?: Band | number; whatIf?: WhatIf }, ctx) => {
    const doc = findCourse(ctx, input.courseId);
    if (isFailure(doc)) return doc;
    const result = grade(doc, input.whatIf);
    if (isFailure(result)) return result;
    const saved = ctx.planning?.targets[doc.course.id];
    const target = input.target !== undefined
      ? typeof input.target === 'number' ? { percent: input.target, source: 'argument' } : { band: input.target, percent: bandTargets[input.target], source: 'argument' }
      : saved && saved in bandTargets ? { band: saved, percent: bandTargets[saved], source: 'saved' } : { band: 'H1', percent: bandTargets.H1, source: 'default' };
    const needed = finalNeeded({ earned: result.totals.earned, weight: result.totals.weight }, target.percent);
    return { value: {
      courseId: doc.course.id, code: doc.course.code, target, status: needed.status, ...(needed.status === 'reachable' ? { neededAverage: needed.percent } : {}),
      earned: result.totals.earned, gradedWeight: result.totals.weight, remainingWeight: 100 - result.totals.weight,
      unidentifiedWeight: Math.max(0, 100 - identifiedWeight(doc)), whatIfApplied: result.whatIfApplied,
    } };
  },
};

const upcomingDeadlines = (label: string): CourseTool => ({
  name: 'upcoming_deadlines', title: 'Upcoming deadlines',
  description: `Assessments due from today through today + days - 1 (${label} dates) across the courses you may read, or the given courseIds, sorted by due date. Submitted and graded items are left out unless includeDone is true. At most 50 items.`,
  input: z.object({
    days: z.number().int().min(1).max(120).default(14).describe('Window length in days, starting today'),
    courseIds: z.array(z.string().min(1)).min(1).max(50).optional().describe('Only these course IDs'),
    includeDone: z.boolean().default(false).describe('Also list submitted and graded items'),
  }),
  run: (input: { days: number; courseIds?: string[]; includeDone: boolean }, ctx) => {
    const outside = (input.courseIds ?? []).find(id => !ctx.scope.includes(id));
    if (outside) return scopeFailure(ctx, outside);
    const ids = input.courseIds ?? ctx.scope;
    const to = addDays(ctx.today, input.days - 1);
    const all = ids.flatMap(id => {
      const doc = ctx.documents.find(entry => entry.course.id === id);
      return (doc?.assessments ?? []).flatMap(item => {
        if (!item.due) return [];
        const day = formatDue(item.due, zoneOf(ctx))!.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < ctx.today || day > to) return [];
        if (!input.includeDone && (item.status === 'submitted' || item.status === 'graded')) return [];
        return [{ courseId: id, code: doc!.course.code, id: item.id, name: item.name, due: formatDue(item.due, zoneOf(ctx)), weight: item.weight, status: item.status }];
      });
    }).sort((a, b) => a.due!.localeCompare(b.due!) || a.courseId.localeCompare(b.courseId) || a.id.localeCompare(b.id));
    const hint = 'Pass fewer days or courseIds to see the rest.';
    return { value: {
      today: ctx.today, from: ctx.today, to, items: all.slice(0, UPCOMING_LIMIT),
      ...(all.length > UPCOMING_LIMIT ? { truncated: { field: 'items', shown: UPCOMING_LIMIT, total: all.length, hint } } : {}),
      notSynced: ids.filter(id => !ctx.documents.some(entry => entry.course.id === id)),
    }, hint };
  },
});

const taskInput = z.object({
  key: z.string().min(1).max(500).optional().describe('Stable task key; numbered arg:1... when missing'),
  title: z.string().min(1).max(200),
  courseId: z.string().max(200).default('').describe('Course ID, or empty for a personal task'),
  courseCode: z.string().max(200).default(''),
  due: date,
  minutes: z.number().gt(0).max(100000).describe('Estimated minutes'),
  spent: z.number().min(0).optional().describe('Minutes already spent'),
  done: z.boolean().optional(),
});
type TaskInput = z.output<typeof taskInput>;
const planSchedule: CourseTool = {
  name: 'plan_schedule', title: 'Plan schedule',
  description: 'Weekly-page study plan: earliest deadline first, filling each day\'s available minutes from today. Uses the tasks argument, else the planning data the page sent; availability from the argument, else the page, else 120 minutes a day. Returns the days from `from` (default today) for `days` days and the overflow (minutes that do not fit before the deadline, or overdue). courseIds only filters what is shown, never what is planned. Returns available: false when there are no tasks.',
  input: z.object({
    from: date.optional().describe('First day to show (YYYY-MM-DD, today or later)'),
    days: z.number().int().min(1).max(28).default(7).describe('Number of days to show'),
    courseIds: z.array(z.string().min(1)).min(1).max(50).optional().describe('Only show these courses'),
    tasks: z.array(taskInput).max(500).optional().describe('Tasks to plan instead of the page\'s tasks'),
    availability: z.array(z.number().min(0).max(1440)).length(7).optional().describe('Available minutes per weekday, Monday first'),
  }),
  run: (input: { from?: string; days: number; courseIds?: string[]; tasks?: TaskInput[]; availability?: number[] }, ctx) => {
    const from = input.from ?? ctx.today;
    if (from < ctx.today) return fail('INVALID_ARGUMENTS', `from: must be today (${ctx.today}) or later.`);
    const outside = (input.courseIds ?? []).find(id => !ctx.scope.includes(id));
    if (outside) return scopeFailure(ctx, outside);
    const tasks = input.tasks ? input.tasks.map((task, index) => ({ ...task, key: task.key ?? `arg:${index + 1}` })) : ctx.planning?.tasks;
    if (!tasks) return { value: { available: false, reason: NOT_AVAILABLE } };
    const keys = tasks.map(task => task.key);
    const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
    if (input.tasks && duplicate !== undefined) return fail('INVALID_ARGUMENTS', `tasks: key ${duplicate} is used more than once.`);
    const availability = input.availability ? parseAvailability(input.availability) : ctx.planning ? parseAvailability(ctx.planning.availability) : [...defaultAvailability];
    const plan = schedulePlan(tasks.map((task): PlanTask => ({ key: task.key, due: task.due, minutes: task.minutes, spent: task.spent, done: task.done })), availability, ctx.today);
    const byKey = new Map(tasks.map(task => [task.key, task]));
    // Output filter only: given courseIds; else scope courses and personal tasks for the page's tasks; else everything.
    const shown = (key: string) => {
      const task = byKey.get(key)!;
      if (input.courseIds) return input.courseIds.includes(task.courseId);
      return input.tasks ? true : task.courseId === '' || ctx.scope.includes(task.courseId);
    };
    const days: Record<string, { key: string; title: string; courseCode: string; minutes: number }[]> = {};
    const to = addDays(from, input.days - 1);
    for (let day = from; day <= to; day = addDays(day, 1)) {
      days[day] = (plan.days[day] ?? []).filter(block => shown(block.key)).map(block => ({ key: block.key, title: byKey.get(block.key)!.title, courseCode: byKey.get(block.key)!.courseCode, minutes: block.minutes }));
    }
    const overflow = plan.overflow.filter(entry => shown(entry.key)).map(entry => ({ key: entry.key, title: byKey.get(entry.key)!.title, courseCode: byKey.get(entry.key)!.courseCode, minutes: entry.minutes, overdue: entry.overdue }));
    return { value: {
      available: true, today: ctx.today, from, to, tasksSource: input.tasks ? 'argument' : 'snapshot',
      availabilitySource: input.availability ? 'argument' : ctx.planning ? 'snapshot' : 'default', days, overflow,
    }, hint: 'Pass fewer days or courseIds to see the rest.' };
  },
};

/**
 * The tool registry whose descriptions name the time zone with `timeLabel` (the institution's English time label,
 * generic-adapters design §4). The tools behave the same for every label; due dates use `ToolContext.timeZone`.
 */
export function courseToolsFor(timeLabel: string): readonly CourseTool[] {
  return [listCourses(timeLabel), getAssessments(timeLabel), calculateGradesTool, finalNeededTool, upcomingDeadlines(timeLabel), planSchedule];
}
/** The registry of the default institution. */
export const courseTools: readonly CourseTool[] = courseToolsFor(DEFAULT_INSTITUTION.wording.timeLabel.en);

/** Provider- and MCP-ready definitions; JSON Schemas are generated from the zod inputs without `$schema`. */
export type ToolParameters = { type: 'object'; properties: Record<string, unknown>; required?: string[] } & Record<string, unknown>;
export function toolDefinitions(tools: readonly CourseTool[] = courseTools): { name: string; title: string; description: string; parameters: ToolParameters }[] {
  return tools.map(tool => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input, { io: 'input' }) as { $schema?: string } & ToolParameters;
    return { name: tool.name, title: tool.title, description: tool.description, parameters };
  });
}

/** Every number rounded to two decimals; -0 becomes 0. */
function rounded(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(2)) + 0 : value;
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rounded(entry)]));
  return value;
}

function result(value: object, ok: boolean): ToolResult { return { ok, text: JSON.stringify(value), value }; }
function failed(failure: Failure): ToolResult { return result(failure, false); }

/** Cuts the largest top-level list so the text fits, keeping as many items as possible; undefined when nothing fits. */
function fit(value: Record<string, unknown>, hint: string | undefined): Record<string, unknown> | undefined {
  const lists = Object.entries(value).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0);
  if (!lists.length) return undefined;
  const [field, list] = lists.reduce((largest, entry) => JSON.stringify(entry[1]).length > JSON.stringify(largest[1]).length ? entry : largest);
  const earlier = value.truncated as { field?: string; total?: number } | undefined;
  const total = earlier?.field === field && typeof earlier.total === 'number' ? earlier.total : list.length;
  const cut = (shown: number) => ({ ...value, [field]: list.slice(0, shown), truncated: { field, shown, total, hint: hint ?? 'Ask for less at a time.' } });
  let low = 0, high = list.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(cut(middle)).length <= RESULT_LIMIT) low = middle; else high = middle - 1;
  }
  return low > 0 && JSON.stringify(cut(low)).length <= RESULT_LIMIT ? cut(low) : undefined;
}

/**
 * Runs one tool call. Never throws: unknown tools, invalid arguments, scope and data problems and oversized results
 * come back as `{ ok: false, value: { error: { code, message } } }`. `text` is exactly what is sent to the model.
 */
export function runTool(name: string, args: unknown, ctx: ToolContext): ToolResult {
  const tool = courseTools.find(entry => entry.name === name);
  if (!tool) return failed(fail('UNKNOWN_TOOL', `There is no tool named ${name}. Available tools: ${courseTools.map(entry => entry.name).join(', ')}.`));
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return failed(fail('INVALID_ARGUMENTS', parsed.error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ')));
  let output: Output | Failure;
  try { output = tool.run(parsed.data as never, ctx); }
  catch (error) { return failed(fail('TOOL_FAILED', `The tool failed on this data (${error instanceof Error ? error.message : String(error)}). Answer without it and say the data could not be read.`)); }
  if (isFailure(output)) return failed(output);
  const value = rounded(output.value) as Record<string, unknown>;
  if (JSON.stringify(value).length <= RESULT_LIMIT) return result(value, true);
  const shortened = fit(value, output.hint);
  return shortened ? result(shortened, true) : failed(fail('RESULT_TOO_LARGE', `The result is larger than ${RESULT_LIMIT} characters. ${output.hint ?? 'Ask for less at a time.'}`));
}
