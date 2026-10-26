import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { AgentFacingError } from '../protocol/errors.js';
import { CANVAS_ORIGIN } from './course-json.js';

/**
 * Canvas API page capture (layered-sync tasks 3.1 and 3.2, #193, #198, #208).
 *
 * The agent opens one fixed API URL in its own Edge window, copies the page and calls `canvas.capture`.
 * The command reads the clipboard itself, so page text never travels through a tool argument. Only the
 * keys needed for the next pipeline stages are kept; raw clipboard text is never stored, logged or put
 * into an error message.
 */

export const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
export const MAX_GROUPS = 100;
export const CANVAS_API_BASE = `${CANVAS_ORIGIN}/api/v1`;
export type CapturePage = 'courses' | 'tabs' | 'groups';

/** Injectable clipboard access: production runs `pbpaste`, tests inject a fake. */
export interface ClipboardReader { read(): string }
export const pbpasteClipboard: ClipboardReader = {
  read(): string {
    // Read up to twice the cap so an oversized clipboard is measured and refused instead of being truncated.
    return execFileSync('pbpaste', [], { encoding: 'utf8', maxBuffer: MAX_CAPTURE_BYTES * 2, timeout: 10_000 });
  },
};

export function canvasApiUrl(page: CapturePage, canvasId?: string): string {
  if (page === 'courses') return `${CANVAS_API_BASE}/courses?enrollment_state=active&include[]=term&per_page=100`;
  if (!canvasId) throw new AgentFacingError('INVALID_INPUT', 'A Canvas course id is required for this page.');
  return page === 'tabs'
    ? `${CANVAS_API_BASE}/courses/${canvasId}/tabs`
    : `${CANVAS_API_BASE}/courses/${canvasId}/assignment_groups?include[]=assignments&include[]=submission&per_page=100`;
}

/** The Canvas source id in a `https://canvas.lms.unimelb.edu.au/courses/{id}` page URL. */
export function canvasCourseId(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    return url.origin === CANVAS_ORIGIN ? /^\/courses\/(\d+)\/?$/.exec(url.pathname)?.[1] : undefined;
  } catch { return undefined; }
}

const refuse = (reason: string): never => {
  throw new AgentFacingError('INVALID_INPUT', `${reason} Nothing was stored. Take a fresh copy of the page and call canvas.capture again.`);
};
const shapeRefuse = (page: CapturePage, issue: z.core.$ZodIssue | undefined): never => {
  const path = issue?.path.length ? ` at ${issue.path.map(part => typeof part === 'number' ? `[${part}]` : String(part)).join('.')}` : '';
  return refuse(`The clipboard is not the expected JSON for the ${page} page${path}.`);
};
const time = z.iso.datetime({ offset: true }).nullable();
const numericId = z.number().int().positive();

const CoursesSchema = z.array(z.object({
  id: numericId,
  name: z.string().max(300),
  course_code: z.string().max(300),
  term: z.object({ name: z.string().max(300) }).nullable().optional(),
}));
const TabsSchema = z.array(z.object({
  id: z.union([z.string().min(1).max(200), z.number()]).transform(String),
  label: z.string().max(300),
  type: z.string().max(100),
  html_url: z.string().max(2048).nullable().optional(),
}));
const GroupsSchema = z.array(z.object({
  id: numericId,
  name: z.string().max(300),
  group_weight: z.number().min(0).max(100),
  assignments: z.array(z.object({
    id: numericId,
    name: z.string().max(300),
    course_id: numericId,
    due_at: time,
    unlock_at: time,
    points_possible: z.number().nonnegative().nullable(),
    assignment_group_id: numericId,
    html_url: z.string().max(2048).nullable().optional(),
    updated_at: time,
    submission: z.object({ workflow_state: z.string().max(100).nullable().optional(), score: z.number().nonnegative().nullable() }).nullable().optional(),
  })),
})).max(MAX_GROUPS);

export interface CanvasCourseCandidate { code: string; name?: string; term: string; pages: { canvas: string } }
export interface CourseCapture { candidates: CanvasCourseCandidate[]; skipped: number }

/** One API-read value: the course document's field shape with `via: "api"` and the API URL as source. */
export interface ApiValue<T> { value: T | null; state: 'found' | 'unknown'; via?: 'api'; checkedAt?: string; source?: string }
export interface CanvasTab { id: string; label: string; type: string; url?: string }
export interface TabsStage { source: string; via: 'api'; tabs: CanvasTab[] }
export interface CanvasGroupValue { id: string; name: string; weight: ApiValue<number> }
export interface CanvasAssignmentValue {
  id: string; name: string; courseId: string; assignmentGroupId: string; htmlUrl?: string;
  group: CanvasGroupValue;
  due: ApiValue<string>; unlockAt: ApiValue<string>; outOf: ApiValue<number>; score: ApiValue<number>;
  status: ApiValue<'not_started' | 'submitted' | 'graded'>; updatedAt: ApiValue<string>;
}
export interface CanvasGroupAssignments extends CanvasGroupValue { assignments: CanvasAssignmentValue[] }
export interface GroupsStage { source: string; via: 'api'; coverage: 'api' | 'partial'; unweighted: boolean; groups: CanvasGroupAssignments[] }

/** Remove any prefix before the first JSON array or object and parse it. */
function parseJson(text: string, page: CapturePage): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_CAPTURE_BYTES) refuse('The clipboard text is larger than 5 MB.');
  const starts = [text.indexOf('['), text.indexOf('{')].filter(index => index >= 0);
  if (!starts.length) shapeRefuse(page, undefined);
  try {
    return JSON.parse(text.slice(Math.min(...starts)));
  } catch {
    shapeRefuse(page, undefined);
  }
}

function termKey(termName: string): string | undefined {
  const year = /(20\d{2})/.exec(termName)?.[1];
  if (!year) return undefined;
  if (/summer/i.test(termName)) return `${year}:SUMMER`;
  if (/winter/i.test(termName)) return `${year}:WINTER`;
  const semester = /sem(?:ester)?\s*([12])(?!\d)/i.exec(termName)?.[1]
    ?? /\bSM\s*([12])\b/i.exec(termName)?.[1]
    ?? /(?:^|[\s,(:])S([12])(?:[\s,)]|$)/i.exec(termName)?.[1];
  return semester ? `${year}:S${semester}` : undefined;
}

/** The first `[A-Z]{4}\d{5}` in the course code, else in the course name. */
function courseCode(course: { course_code: string; name: string }): string | undefined {
  const match = /[A-Za-z]{4}\d{5}/.exec(course.course_code) ?? /[A-Za-z]{4}\d{5}/.exec(course.name);
  return match?.[0].toUpperCase();
}

export function parseCanvasCourses(text: string): CourseCapture {
  const parsed = CoursesSchema.safeParse(parseJson(text, 'courses'));
  const courses = parsed.success ? parsed.data : shapeRefuse('courses', parsed.error.issues[0]);
  const candidates: CanvasCourseCandidate[] = [];
  let skipped = 0;
  for (const course of courses) {
    const code = courseCode(course);
    const term = course.term?.name ? termKey(course.term.name) : undefined;
    if (!code || !term) { skipped++; continue; }
    candidates.push({ code, ...(course.name.trim() ? { name: course.name } : {}), term,
      pages: { canvas: `${CANVAS_ORIGIN}/courses/${course.id}` } });
  }
  return { candidates, skipped };
}

export function parseCanvasTabs(text: string, options: { source: string }): TabsStage {
  const parsed = TabsSchema.safeParse(parseJson(text, 'tabs'));
  const tabs = parsed.success ? parsed.data : shapeRefuse('tabs', parsed.error.issues[0]);
  return { source: options.source, via: 'api', tabs: tabs.map(tab => ({
    id: tab.id, label: tab.label, type: tab.type, ...(tab.html_url ? { url: tab.html_url } : {}),
  })) };
}

function found<T>(value: T, source: string): ApiValue<T> { return { value, state: 'found', via: 'api', source }; }
function apiValue<T>(value: T | null, source: string, checkedAt: string): ApiValue<T> {
  return value === null ? { value: null, state: 'unknown', checkedAt } : found(value, source);
}
function submissionStatus(submission: { workflow_state?: string | null } | null | undefined): 'not_started' | 'submitted' | 'graded' {
  const state = submission?.workflow_state;
  if (state === 'graded') return 'graded';
  if (state === 'submitted' || state === 'pending_review') return 'submitted';
  return 'not_started';
}

export function parseCanvasGroups(text: string, options: { source: string; courseId: string; now?: () => Date }): GroupsStage {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const raw = parseJson(text, 'groups');
  if (Array.isArray(raw) && raw.length > MAX_GROUPS) refuse(`The groups page has ${raw.length} groups; a capture accepts at most ${MAX_GROUPS}.`);
  const parsed = GroupsSchema.safeParse(raw);
  const data = parsed.success ? parsed.data : shapeRefuse('groups', parsed.error.issues[0]);
  const expected = String(options.courseId);
  for (const group of data) for (const assignment of group.assignments) {
    if (String(assignment.course_id) !== expected) {
      refuse(`The groups page lists assignments for Canvas course ${assignment.course_id}, not ${expected}.`);
    }
  }
  const groups = data.map(group => {
    const value: CanvasGroupValue = { id: String(group.id), name: group.name,
      weight: apiValue(group.group_weight, options.source, checkedAt) };
    return { ...value, assignments: group.assignments.map(assignment => ({
      id: String(assignment.id), name: assignment.name, courseId: String(assignment.course_id),
      assignmentGroupId: String(assignment.assignment_group_id),
      ...(assignment.html_url ? { htmlUrl: assignment.html_url } : {}),
      group: { ...value, weight: { ...value.weight } },
      due: apiValue(assignment.due_at, options.source, checkedAt),
      unlockAt: apiValue(assignment.unlock_at, options.source, checkedAt),
      outOf: apiValue(assignment.points_possible, options.source, checkedAt),
      score: apiValue(assignment.submission?.score ?? null, options.source, checkedAt),
      status: found(submissionStatus(assignment.submission), options.source),
      updatedAt: apiValue(assignment.updated_at, options.source, checkedAt),
    })) };
  });
  return { source: options.source, via: 'api', coverage: groups.length === MAX_GROUPS ? 'partial' : 'api',
    unweighted: groups.every(group => group.weight.value === 0), groups };
}
