import { randomUUID } from 'node:crypto';
import { CoursePagesSchema, CourseTermSchema, type CourseSelection, type Run, type SyncJob, type SyncOutcome } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { AgentFacingError, CourseworkError } from '../protocol/errors.js';
import { courseKey, MAX_SUBMISSIONS, normalizeCourseCode, validateCourseDocument, type DocumentIssue } from './course-json.js';
import { importCourseDocument, type ImportOptions } from './course-import.js';

/** A job older than this counts as ended (stale lock), above the 20-minute run bound. */
export const STALE_AFTER_MS = 25 * 60_000;
export interface OfferInput { jobId: string; courses: { code: string; name?: string; term: string; pages: { canvas?: string; ed?: string } }[]; blocked: ('canvas' | 'ed')[] }
export interface SelectInput { selections: { key: string; selected: boolean }[] }
export interface ImportInput { jobId: string; document: unknown }
export interface SyncJobsOptions { now?: () => Date; annotatedWeight?: ImportOptions['annotatedWeight'] }

const describeIssues = (issues: readonly DocumentIssue[]) => {
  const shown = issues.slice(0, 100).map(issue => `${issue.path || '(document)'} (${issue.reason})`).join('; ');
  return issues.length > 100 ? `${shown}; and ${issues.length - 100} more` : shown;
};

/**
 * Sync job state and the agent's job-scoped commands. Everything lives in the store, because the agent's
 * commands run in the separate `coursework mcp` process.
 */
export class SyncJobs {
  constructor(private readonly store: SqliteRepository, private readonly options: SyncJobsOptions = {}) {}
  private now(): Date { return this.options.now?.() ?? new Date(); }
  isActive(job: SyncJob): boolean { return job.endedAt === undefined && this.now().getTime() - Date.parse(job.startedAt) < STALE_AFTER_MS; }
  active(): SyncJob | undefined { return this.store.listSyncJobs().find(job => this.isActive(job)); }
  load(id: string): SyncJob | undefined { return this.store.loadSyncJob(id); }
  candidates(): CourseSelection[] { return this.store.listCourseSelections(); }
  /** When the newest stored document of this course was stored; undefined when no document was stored yet. */
  storedAt(courseId: string): string | undefined {
    return this.store.listSyncJobs().flatMap(job => Object.values(job.results ?? {})).filter(result => result.courseId === courseId)
      .map(result => result.storedAt).sort().at(-1);
  }

  /** The store's write lock makes this the cross-process lock: one active job at a time. */
  open(courses: readonly string[]): SyncJob {
    return this.store.transaction(() => {
      if (this.active()) throw new CourseworkError('LOCKED', 'A sync is already running.');
      const job: SyncJob = { id: randomUUID(), startedAt: this.now().toISOString(), courses: [...courses], submissions: {} };
      this.store.saveSyncJob(job);
      return job;
    });
  }
  /** Close the job and record its Run together. */
  close(id: string, outcome: SyncOutcome, run: Run): void {
    this.store.transaction(() => {
      const job = this.store.loadSyncJob(id);
      if (!job) throw new CourseworkError('NOT_FOUND', 'Sync job not found.');
      this.store.saveSyncJob({ ...job, endedAt: run.endedAt, outcome });
      this.store.recordRun(run);
    });
  }
  private requireActive(jobId: string): SyncJob {
    const job = this.store.loadSyncJob(jobId);
    if (!job || !this.isActive(job)) throw new AgentFacingError('INVALID_INPUT', 'No active sync job with this id; these commands work only during a sync run.');
    return job;
  }

  offer(input: OfferInput) {
    return this.store.transaction(() => {
      const job = this.requireActive(input.jobId);
      const issues: DocumentIssue[] = [];
      const offered = input.courses.map((course, index) => {
        const code = normalizeCourseCode(course.code);
        if (!code) issues.push({ path: `courses[${index}].code`, reason: 'needs one course code like ABCD10001' });
        if (!CourseTermSchema.safeParse(course.term).success) issues.push({ path: `courses[${index}].term`, reason: 'use YYYY:S1, YYYY:S2, YYYY:SUMMER or YYYY:WINTER' });
        const pages = CoursePagesSchema.safeParse(course.pages);
        if (!pages.success) for (const issue of pages.error.issues) issues.push({ path: `courses[${index}].pages.${issue.path.join('.')}`, reason: 'must be a Canvas or Ed URL on its own platform' });
        return { code, course, pages: pages.success ? pages.data : {} };
      });
      if (issues.length) throw new AgentFacingError('INVALID_INPUT', `Offer refused; nothing was stored. Fix: ${describeIssues(issues)}`);
      const at = this.now().toISOString();
      const existing = new Map(this.store.listCourseSelections().map(row => [row.key, row]));
      const rows = offered.map(({ code, course, pages }) => {
        const key = courseKey(code!, course.term);
        const previous = existing.get(key);
        // An earlier decision stays; the agent never changes a selection.
        return { ...previous, key, code: code!, term: course.term, pages: { ...previous?.pages, ...pages }, offeredAt: at,
          ...(course.name ? { name: course.name } : previous?.name ? { name: previous.name } : {}) } satisfies CourseSelection;
      });
      this.store.saveCourseSelections(rows);
      this.store.saveSyncJob({ ...job, blocked: [...new Set([...job.blocked ?? [], ...input.blocked])] });
      const all = this.store.listCourseSelections();
      return { stored: rows.length, undecided: all.filter(row => row.selected === undefined).length, selected: all.filter(row => row.selected === true).length };
    });
  }

  /** Owner only (the registry gates it): record selected or not for offered candidates, all or nothing. */
  select(input: SelectInput) {
    return this.store.transaction(() => {
      const existing = new Map(this.store.listCourseSelections().map(row => [row.key, row]));
      const missing = input.selections.filter(selection => !existing.has(selection.key));
      if (missing.length) throw new CourseworkError('NOT_FOUND', 'Course candidate not found.');
      const at = this.now().toISOString();
      this.store.saveCourseSelections(input.selections.map(selection => ({ ...existing.get(selection.key)!, selected: selection.selected, decidedAt: at })));
      return { recorded: input.selections.length };
    });
  }

  /** Validate and store one course document; the submission count changes in the same transaction as the decision. */
  import(input: ImportInput) {
    const outcome = this.store.transaction(() => {
      const job = this.requireActive(input.jobId);
      const now = this.now().toISOString();
      const first = validateCourseDocument(input.document, { final: false, now });
      if (!first.key) return { refused: `Submission refused; nothing was stored. The document needs a valid course code and term: ${describeIssues(first.errors)}` };
      const key = first.key;
      if (!job.courses.includes(key)) return { refused: `Course ${key} is not selected for this sync job; read only the courses listed in the prompt.` };
      const submission = (job.submissions[key] ?? 0) + 1;
      const counted: SyncJob = { ...job, submissions: { ...job.submissions, [key]: submission } };
      const final = submission >= MAX_SUBMISSIONS;
      const checked = final ? validateCourseDocument(input.document, { final: true, now }) : first;
      if (!checked.document || checked.fatal) {
        this.store.saveSyncJob(counted);
        return { refused: final
          ? `Submission ${submission} for ${key} refused; the course is reported as not read. ${describeIssues(checked.errors)}`
          : `Submission ${submission} of ${MAX_SUBMISSIONS} for ${key} refused; nothing was stored. Re-read these fields (take a screenshot for empty ones) and submit again: ${describeIssues(checked.errors)}` };
      }
      const result = importCourseDocument(this.store, checked.document, { at: now, annotatedWeight: this.options.annotatedWeight });
      const weightSum = checked.warnings.find(warning => warning.code === 'WEIGHT_SUM')?.sum;
      this.store.saveSyncJob({ ...counted, results: { ...counted.results, [key]: { courseId: result.courseId, storedAt: now,
        components: result.components, items: result.items, unknownFields: checked.unknown.slice(0, 500), dropped: checked.dropped.slice(0, 500),
        warnings: [...checked.warnings.map(warning => warning.code), ...result.warnings], ...(weightSum !== undefined ? { weightSum } : {}),
        platforms: checked.document.course.platforms, policyChanged: result.policyChanged } } });
      return { receipt: { stored: true as const, key, submission, courseId: result.courseId, components: result.components, items: result.items,
        assessments: result.assessments, retired: result.retired, unknownFields: checked.unknown.slice(0, 500), dropped: checked.dropped.slice(0, 500),
        warnings: [...checked.warnings, ...result.warnings.map(code => ({ code }))] } };
    });
    // The count is committed before the refusal reaches the agent.
    if ('refused' in outcome) throw new AgentFacingError('INVALID_INPUT', outcome.refused!);
    return outcome.receipt;
  }
}
