import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CoursePagesSchema, CourseTermSchema, type CourseSelection, type Run, type SyncJob, type SyncOutcome } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { AgentFacingError, CourseworkError } from '../protocol/errors.js';
import { AssignmentSavedInputSchema, CourseMapInputSchema, ItemsClassifyInputSchema, MaterialsSavedInputSchema, QuizzesReadInputSchema,
  type AssignmentSavedInput, type CourseMapInput, type ItemsClassifyInput, type MaterialsSavedInput, type QuizzesReadInput } from '../protocol/sync.js';
import { courseKey, MAX_SUBMISSIONS, normalizeCourseCode, validateCourseDocument, type CheckedDocument, type DocumentIssue } from './course-json.js';
import { importCourseDocument, type ImportOptions } from './course-import.js';
import { canvasApiUrl, canvasCourseId, parseCanvasCourses, parseCanvasGroups, parseCanvasTabs, pbpasteClipboard,
  type CapturePage, type ClipboardReader, type GroupsStage, type TabsStage } from './canvas-api.js';
import { handbookUrl, parseHandbook, type SkeletonStage } from './handbook.js';

/** A run ends within 20 minutes per selected course, and never sooner than 20 minutes. */
export const RUN_BOUND_PER_COURSE_MS = 20 * 60_000;
/** A job older than its own run bound plus this counts as ended (stale lock). */
export const STALE_GRACE_MS = 5 * 60_000;
export function runBoundMs(courseCount: number): number {
  return Math.max(RUN_BOUND_PER_COURSE_MS, courseCount * RUN_BOUND_PER_COURSE_MS);
}
export interface OfferInput { jobId: string; courses: { code: string; name?: string; term: string; pages: { canvas?: string; ed?: string } }[]; blocked: ('canvas' | 'ed')[] }
export interface SelectInput { selections: { key: string; selected: boolean }[] }
export interface ImportInput { jobId: string; document: unknown }
export interface CaptureInput { jobId: string; courseKey?: string; page: CapturePage }
export interface HandbookCaptureInput { jobId: string; courseKey: string }
export interface SyncJobsOptions { now?: () => Date; annotatedWeight?: ImportOptions['annotatedWeight']; importer?: typeof importCourseDocument; clipboard?: ClipboardReader }

const describeIssues = (issues: readonly DocumentIssue[]) => {
  const shown = issues.slice(0, 100).map(issue => `${issue.path || '(document)'} (${issue.reason})`).join('; ');
  return issues.length > 100 ? `${shown}; and ${issues.length - 100} more` : shown;
};

const describeStageIssues = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) => {
  const shown = issues.slice(0, 50).map(issue => `${issue.path.map(String).join('.') || '(input)'} (${issue.message})`).join('; ');
  return issues.length > 50 ? `${shown}; and ${issues.length - 50} more` : shown;
};

/**
 * Sync job state and the agent's job-scoped commands. Everything lives in the store, because the agent's
 * commands run in the separate `coursework mcp` process.
 */
export class SyncJobs {
  constructor(private readonly store: SqliteRepository, private readonly options: SyncJobsOptions = {}) {}
  private now(): Date { return this.options.now?.() ?? new Date(); }
  /** Active until the job ends or is older than its own run bound plus the grace period. */
  isActive(job: SyncJob): boolean {
    return job.endedAt === undefined && this.now().getTime() - Date.parse(job.startedAt) < runBoundMs(job.courses.length) + STALE_GRACE_MS;
  }
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
  /** Close the job and record its Run together; the Run is built from the job as read inside the same transaction. */
  close<T>(id: string, build: (job: SyncJob) => { outcome: SyncOutcome; run: Run; value?: T }): T | undefined {
    return this.store.transaction(() => {
      const job = this.store.loadSyncJob(id);
      if (!job) throw new CourseworkError('NOT_FOUND', 'Sync job not found.');
      const { outcome, run, value } = build(job);
      this.store.saveSyncJob({ ...job, endedAt: run.endedAt, outcome });
      this.store.recordRun(run);
      return value;
    });
  }
  private requireActive(jobId: string, agentFacing = true): SyncJob {
    const job = this.store.loadSyncJob(jobId);
    if (!job || !this.isActive(job)) {
      const message = 'No active sync job with this id; these commands work only during a sync run. Nothing was stored.';
      // Code-side callers are not agents, so their refusal must not be offered to one.
      throw agentFacing ? new AgentFacingError('INVALID_INPUT', message) : new CourseworkError('INVALID_INPUT', message);
    }
    return job;
  }

  offer(input: OfferInput) {
    return this.store.transaction(() => {
      const job = this.requireActive(input.jobId);
      // An empty offer without blocked platforms means the agent read nothing (for example a locked screen).
      if (!input.courses.length && !input.blocked.length) {
        throw new AgentFacingError('INVALID_INPUT', 'Offer the courses you see, or report the platforms you could not read in `blocked`.');
      }
      return this.offerWithin(job, input.courses, input.blocked);
    });
  }

  /** Offer candidates inside an existing transaction; callers decide whether an empty list is a refusal. */
  private offerWithin(job: SyncJob, courses: OfferInput['courses'], blocked: OfferInput['blocked']) {
    const issues: DocumentIssue[] = [];
    const offered = courses.map((course, index) => {
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
    this.store.saveSyncJob({ ...job, blocked: [...new Set([...job.blocked ?? [], ...blocked])] });
    const all = this.store.listCourseSelections();
    return { stored: rows.length, undecided: all.filter(row => row.selected === undefined).length, selected: all.filter(row => row.selected === true).length };
  }

  /**
   * Store one stage result for a course of an active job. Tool calls run in the `coursework mcp` process, so the
   * orchestrator reads the stage back from the store. 5.3's commands and the Step 2 pipeline use this same write.
   */
  recordStage(jobId: string, courseKey: string | undefined, stage: string, value: unknown) {
    return this.store.transaction(() => {
      const job = this.requireActive(jobId);
      const key = this.requireStageCourse(job, courseKey, stage);
      const stages = { ...job.stages, [key]: { ...job.stages?.[key], [stage]: value } } as SyncJob['stages'];
      this.store.saveSyncJob({ ...job, stages });
      return { courseKey: key, stage };
    });
  }

  private requireStageCourse(job: SyncJob, key: string | undefined, stage: string): string {
    if (!key) throw new AgentFacingError('INVALID_INPUT', `courseKey is required for the ${stage} stage; use the key of one of this job's selected courses.`);
    if (!job.courses.includes(key)) throw new AgentFacingError('INVALID_INPUT', `Course ${key} is not selected for this sync job; store only the courses listed in the prompt. Nothing was stored.`);
    return key;
  }

  /** Validate one stage payload again for direct callers, with the contract path the agent must fix. */
  private stageValue<S extends z.ZodType>(schema: S, input: unknown, command: string): z.output<S> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new AgentFacingError('INVALID_INPUT', `${command} refused; nothing was stored. Fix: ${describeStageIssues(parsed.error.issues)}`);
    return parsed.data;
  }

  private requireCaptureCourse(job: SyncJob, key: string | undefined, page: CapturePage): { key: string; canvasId: string } {
    if (!key) throw new AgentFacingError('INVALID_INPUT', `courseKey is required for the ${page} page; use the key of one of this job's selected courses.`);
    if (!job.courses.includes(key)) throw new AgentFacingError('INVALID_INPUT', `Course ${key} is not selected for this sync job; capture only the courses listed in the prompt.`);
    const course = this.store.listCourseSelections().find(row => row.key === key);
    const canvasId = course?.pages.canvas ? canvasCourseId(course.pages.canvas) : undefined;
    if (!canvasId) throw new AgentFacingError('INVALID_INPUT', `Course ${key} has no Canvas course URL; capture only selected courses with a Canvas source id.`);
    return { key, canvasId };
  }

  private saveStage(jobId: string, key: string, page: 'tabs' | 'groups', value: TabsStage | GroupsStage): void {
    this.recordStage(jobId, key, page, value);
  }

  private requireHandbookCourse(job: SyncJob, key: string): { code: string; term: string } {
    if (!job.courses.includes(key)) throw new AgentFacingError('INVALID_INPUT', `Course ${key} is not selected for this sync job; capture only the courses listed in the prompt.`);
    const course = this.store.listCourseSelections().find(row => row.key === key);
    if (course) return { code: course.code, term: course.term };
    // The job's course list is authoritative; a key still names its code and term when the selection row is gone.
    const match = /^([A-Z]{4}\d{5}):(\d{4}:(?:S1|S2|SUMMER|WINTER))$/.exec(key);
    if (!match) throw new AgentFacingError('INVALID_INPUT', `Course ${key} is not a valid course key; capture only courses of this job.`);
    return { code: match[1]!, term: match[2]! };
  }

  private saveSkeleton(jobId: string, key: string, value: SkeletonStage): void {
    this.recordStage(jobId, key, 'skeleton', value);
  }

  /** Read the copied Handbook page and store only the parsed skeleton, never the raw text. */
  handbook(input: HandbookCaptureInput) {
    const active = this.requireActive(input.jobId);
    const course = this.requireHandbookCourse(active, input.courseKey);
    let text: string;
    try {
      text = (this.options.clipboard ?? pbpasteClipboard).read();
    } catch {
      throw new AgentFacingError('INVALID_INPUT', 'Could not read the clipboard. Nothing was stored. Take a fresh copy of the assessment page and call handbook.capture again.');
    }
    const skeleton = parseHandbook(text, { source: handbookUrl(course.code, course.term) });
    this.saveSkeleton(input.jobId, input.courseKey, skeleton);
    return { components: skeleton.components.length };
  }

  /** Read one Canvas API page from the clipboard and store only its parsed values, never the raw text. */
  capture(input: CaptureInput) {
    const active = this.requireActive(input.jobId);
    const target = input.page === 'courses' ? undefined : this.requireCaptureCourse(active, input.courseKey, input.page);
    let text: string;
    try {
      text = (this.options.clipboard ?? pbpasteClipboard).read();
    } catch {
      throw new AgentFacingError('INVALID_INPUT', 'Could not read the clipboard. Nothing was stored. Take a fresh copy of the page and call canvas.capture again.');
    }
    if (input.page === 'courses') {
      const parsed = parseCanvasCourses(text);
      return this.store.transaction(() => {
        const job = this.requireActive(input.jobId);
        const offered = this.offerWithin(job, parsed.candidates, []);
        return { page: 'courses' as const, stored: offered.stored, skipped: parsed.skipped,
          undecided: offered.undecided, selected: offered.selected };
      });
    }
    const source = canvasApiUrl(input.page, target!.canvasId);
    if (input.page === 'tabs') {
      const parsed = parseCanvasTabs(text, { source });
      this.saveStage(input.jobId, target!.key, 'tabs', parsed);
      return { page: 'tabs' as const, tabs: parsed.tabs.length };
    }
    const parsed = parseCanvasGroups(text, { source, courseId: target!.canvasId, now: () => this.now() });
    this.saveStage(input.jobId, target!.key, 'groups', parsed);
    return { page: 'groups' as const, groups: parsed.groups.length,
      assignments: parsed.groups.reduce((total, group) => total + group.assignments.length, 0), coverage: parsed.coverage };
  }

  /** Store the home page map; code routes each link by URL, so no route is accepted or stored. */
  map(input: CourseMapInput) {
    const value = this.stageValue(CourseMapInputSchema, input, 'course.map');
    this.recordStage(value.jobId, value.courseKey, 'map', { lms: value.lms, ed: value.ed, syllabus: value.syllabus, links: value.links });
    return { links: value.links.length };
  }

  /** Store the quiz list text the API does not hold; nothing deep is saved. */
  quizzes(input: QuizzesReadInput) {
    const value = this.stageValue(QuizzesReadInputSchema, input, 'quizzes.read');
    this.recordStage(value.jobId, value.courseKey, 'quizzes', { quizzes: value.quizzes });
    return { quizzes: value.quizzes.length };
  }

  /** Store one assignment's quoted policy and saved file names, never its instructions or rubric. */
  assignmentSaved(input: AssignmentSavedInput) {
    const value = this.stageValue(AssignmentSavedInputSchema, input, 'assignment.saved');
    // The same stage key as `stageFor({ kind: 'assignment', target })`.
    this.recordStage(value.jobId, value.courseKey, `assignments.${value.assignmentId}`, { policy: value.policy, files: value.files });
    return { files: value.files.length };
  }

  /** Store downloaded file names and link-only targets separately; recordings stay links. */
  materialsSaved(input: MaterialsSavedInput) {
    const value = this.stageValue(MaterialsSavedInputSchema, input, 'materials.saved');
    this.recordStage(value.jobId, value.courseKey, 'materials', { files: value.files, links: value.links });
    return { files: value.files.length, links: value.links.length };
  }

  /** Store the six-category classification with its evidence; ids are unique within the call. */
  classify(input: ItemsClassifyInput) {
    const value = this.stageValue(ItemsClassifyInputSchema, input, 'items.classify');
    this.recordStage(value.jobId, value.courseKey, 'classification', { items: value.items });
    return { items: value.items.length };
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
      const stored = this.storeChecked(job, checked, now, submission);
      if (!stored) {
        this.store.saveSyncJob(counted);
        return { refused: `Submission ${submission} for ${key} could not be stored because of an internal error; nothing was stored. Submit the course again.` };
      }
      return { receipt: { ...stored.receipt, submission } };
    });
    // The count is committed before the refusal reaches the agent.
    if ('refused' in outcome) throw new AgentFacingError('INVALID_INPUT', outcome.refused!);
    return outcome.receipt;
  }

  /**
   * Code-side import of a built document: final validation, the same store mapping and `results[courseKey]`
   * recording as `import()`, but no submission count and no agent-facing refusal.
   */
  storeBuilt(jobId: string, document: unknown) {
    return this.store.transaction(() => {
      const job = this.requireActive(jobId, false);
      const now = this.now().toISOString();
      const checked = validateCourseDocument(document, { final: true, now });
      if (!checked.document || checked.fatal || !checked.key) {
        throw new CourseworkError('INVALID_INPUT', `Built course document refused; nothing was stored. ${describeIssues(checked.errors)}`);
      }
      const key = checked.key;
      if (!job.courses.includes(key)) throw new CourseworkError('INVALID_INPUT', `Course ${key} is not selected for this sync job.`);
      const stored = this.storeChecked(job, checked, now);
      if (!stored) throw new CourseworkError('INTERNAL', `Built document for ${key} could not be stored.`);
      return stored.receipt;
    });
  }

  /** The one write path both `import()` and `storeBuilt()` use; the caller has already validated the document. */
  private storeChecked(job: SyncJob, checked: CheckedDocument, at: string, submission?: number) {
    const document = checked.document!;
    const key = checked.key!;
    let result: ReturnType<typeof importCourseDocument>;
    try {
      // A savepoint inside this transaction: a failed import leaves nothing partial, but the submission still counts.
      const importer = this.options.importer ?? importCourseDocument;
      result = this.store.transaction(() => importer(this.store, document, { at, annotatedWeight: this.options.annotatedWeight }));
    } catch {
      return undefined;
    }
    const weightSum = checked.warnings.find(warning => warning.code === 'WEIGHT_SUM')?.sum;
    const counted: SyncJob = submission === undefined ? job : { ...job, submissions: { ...job.submissions, [key]: submission } };
    this.store.saveSyncJob({ ...counted, results: { ...counted.results, [key]: { courseId: result.courseId, storedAt: at,
      components: result.components, items: result.items, unknownFields: checked.unknown.slice(0, 500), dropped: checked.dropped.slice(0, 500),
      warnings: [...checked.warnings.map(warning => warning.code), ...result.warnings], ...(weightSum !== undefined ? { weightSum } : {}),
      platforms: document.course.platforms, policyChanged: result.policyChanged } } });
    return { key, result, receipt: { stored: true as const, key, courseId: result.courseId, components: result.components, items: result.items,
      assessments: result.assessments, retired: result.retired, unknownFields: checked.unknown.slice(0, 500), dropped: checked.dropped.slice(0, 500),
      warnings: [...checked.warnings, ...result.warnings.map(code => ({ code }))] } };
  }
}
