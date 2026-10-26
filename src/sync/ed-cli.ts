import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { CourseSelection } from '../domain/schemas.js';
import type { PipelineJobContext } from './agent-job.js';
import type { CourseItem } from './course-json.js';
import type { SyncJobs } from './jobs.js';

/**
 * Read Ed through the owner's `edstem` CLI (layered-sync task 7.2, #219).
 *
 * The CLI owns the owner's Ed token; this module never reads or stores it. Only the JSON fields listed in the
 * issue are parsed, with bounded sizes, and every failure (missing command, signed out, non-zero exit, malformed
 * JSON) makes the CLI unavailable for the course so the orchestrator can run the one fallback Ed page job.
 */

/** The command runner is injectable so tests never run the real `edstem` command. */
export interface EdCommandResult { code: number; stdout: string }
export type EdRunner = (args: string[]) => Promise<EdCommandResult>;

/** A cap on one command's stdout, so a broken CLI cannot exhaust memory. */
export const MAX_ED_STDOUT_BYTES = 4 * 1024 * 1024;
const ED_COMMAND_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

/** Production runner: `edstem` with a timeout and a stdout cap; failures become a non-zero result. */
export const execFileEdRunner: EdRunner = async args => {
  try {
    const { stdout } = await execFileAsync('edstem', args, { encoding: 'utf8',
      timeout: ED_COMMAND_TIMEOUT_MS, maxBuffer: MAX_ED_STDOUT_BYTES });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    return { code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '' };
  }
};

/** The stage key noting that the fallback Ed job was used instead of the CLI. */
export const ED_CLI_NOTE_STAGE = 'edCli';
export const ED_CLI_NOT_USED = { cli: 'not-used' } as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const identifier = z.union([z.number().int().positive(), text(64)]).transform(String);
const time = z.iso.datetime({ offset: true }).nullable();
const UnitsSchema = z.array(z.object({
  id: z.number().int().positive(),
  code: z.string().max(300),
  year: z.string().max(20),
  session: z.string().max(100),
})).max(1000);
const LessonsSchema = z.array(z.object({
  id: identifier,
  courseId: identifier,
  title: text(300),
  moduleName: z.string().max(300).optional(),
  dueAt: time,
})).max(500);
const FilesSchema = z.array(z.object({
  filename: text(300),
  lessonId: identifier,
})).max(2000);
const AuthSchema = z.object({ authenticated: z.boolean() });

export interface EdUnit { id: number; code: string; year: string; session: string }
export interface EdApiLesson { id: string; title: string; module: string; dueAt: string | null; url: string }
export interface EdFile { lessonId: string; filename: string }
export interface EdApiStage { via: 'api'; source: 'edstem-cli'; unitId: number; lessons: EdApiLesson[]; files: EdFile[] }
export interface EdPageLesson { title: string; dueAt?: string; quote: string }
export interface EdPageStage { via: 'ax'; source: 'edstem-page'; lessons: EdPageLesson[] }
export type EdStage = EdApiStage | EdPageStage;

/** A course-document Ed item; 5.2b's build merges these with the course's components. */
export type EdItem = Pick<CourseItem, 'key' | 'url' | 'name' | 'kind' | 'due'>;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sessionHas = (session: string, value: string): boolean => new RegExp(`(?:^|\\D)${value}(?!\\d)`).test(session);

/**
 * The one unit for this course: its code starts with the course code at a word boundary, and its year and
 * session match the course term. A second candidate makes the answer ambiguous, so nothing is read.
 */
export function matchUnit(units: readonly EdUnit[], course: Pick<CourseSelection, 'code' | 'term'>): EdUnit | undefined {
  const term = /^(\d{4}):(S1|S2|SUMMER|WINTER)$/.exec(course.term);
  if (!term) return undefined;
  const year = term[1]!;
  const season = term[2]!;
  const code = new RegExp(`^${escapeRegExp(course.code)}(?![A-Za-z0-9])`, 'i');
  const matches = units.filter(unit => code.test(unit.code.trim()) && unit.year.trim() === year
    && (season === 'SUMMER' ? /summer/i.test(unit.session)
      : season === 'WINTER' ? /winter/i.test(unit.session)
        : sessionHas(unit.session, season === 'S1' ? '1' : '2')));
  return matches.length === 1 ? matches[0] : undefined;
}

function lessonUrl(courseId: string, lessonId: string): string {
  return `https://edstem.org/au/courses/${courseId}/lessons/${lessonId}`;
}

/** Parse one command's JSON output; a non-zero exit, oversized output or malformed shape is unavailable. */
async function readJson<S extends z.ZodType>(runner: EdRunner, args: string[], schema: S): Promise<z.output<S> | undefined> {
  let result: EdCommandResult;
  try { result = await runner(args); } catch { return undefined; }
  if (!result || typeof result.code !== 'number' || typeof result.stdout !== 'string' || result.code !== 0) return undefined;
  if (Buffer.byteLength(result.stdout, 'utf8') > MAX_ED_STDOUT_BYTES) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { return undefined; }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** True only when `edstem --version` succeeds and `auth status --json` says authenticated; never throws. */
export async function edAvailable(runner: EdRunner): Promise<boolean> {
  try {
    const version = await runner(['--version']);
    if (version.code !== 0) return false;
    const auth = await readJson(runner, ['auth', 'status', '--json'], AuthSchema);
    return auth?.authenticated === true;
  } catch { return false; }
}

/**
 * Read the course's Ed unit, lessons and lesson files through the CLI. `dest` additionally downloads each
 * lesson that has files. Any failure or malformed output means the CLI is unavailable for this course.
 */
export async function readEdCourse(runner: EdRunner, course: Pick<CourseSelection, 'code' | 'term'>,
  options: { dest?: string } = {}): Promise<EdApiStage | undefined> {
  const units = await readJson(runner, ['units', 'list', '--json'], UnitsSchema);
  if (!units) return undefined;
  const unit = matchUnit(units, course);
  if (!unit) return undefined;

  const lessons = await readJson(runner, ['lessons', 'list', String(unit.id), '--json', '--module', 'all', '--state', 'all', '--status', 'all'], LessonsSchema);
  if (!lessons) return undefined;

  const files: EdFile[] = [];
  for (const lesson of lessons) {
    const listed = await readJson(runner, ['files', 'list', lesson.id, '--json'], FilesSchema);
    if (!listed) return undefined;
    files.push(...listed.map(file => ({ lessonId: file.lessonId, filename: file.filename })));
    if (options.dest && listed.length) {
      let download: EdCommandResult;
      try { download = await runner(['files', 'get', lesson.id, '--dest', options.dest]); } catch { return undefined; }
      if (download.code !== 0) return undefined;
    }
  }

  return {
    via: 'api', source: 'edstem-cli', unitId: unit.id,
    lessons: lessons.map(lesson => ({ id: lesson.id, title: lesson.title, module: lesson.moduleName ?? '',
      dueAt: lesson.dueAt, url: lessonUrl(lesson.courseId, lesson.id) })),
    files,
  };
}

/**
 * The pipeline's Ed hook: store the CLI stage when it is available and its unit matches; otherwise do
 * nothing so the orchestrator runs the one fallback Ed page job.
 */
export function edHook(runner: EdRunner, jobs: Pick<SyncJobs, 'recordStage'>, options: { dest?: string } = {}) {
  return async (courseKey: string, ctx: PipelineJobContext): Promise<void> => {
    if (!(await edAvailable(runner))) return;
    const stage = await readEdCourse(runner, ctx.course, options);
    if (!stage) return;
    try { jobs.recordStage(ctx.jobId, courseKey, 'ed', stage); } catch { /* The orchestrator falls back. */ }
  };
}

/**
 * Map dated CLI lessons to course-document items: only lessons with a due date become items, and the due
 * and name carry `via: "api"` with the Ed lesson URL as source. The kind is left for 5.2b's classification.
 */
export function edItems(stage: EdStage, courseCode: string, checkedAt = new Date().toISOString()): EdItem[] {
  if (stage.via !== 'api') return [];
  return stage.lessons.flatMap(lesson => lesson.dueAt === null ? [] : [{
    key: `${courseCode}:ed:lesson:${lesson.id}`,
    url: lesson.url,
    name: { value: lesson.title, state: 'found' as const, via: 'api' as const, source: lesson.url },
    kind: { value: null, state: 'unknown' as const, checkedAt },
    due: { value: lesson.dueAt, state: 'found' as const, via: 'api' as const, source: lesson.url },
  }]);
}
