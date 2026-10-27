import { createHash } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentTool } from '../agent/adapter.js';
import { RunSchema, type CourseSelection, type Run, type RunJob, type SyncJob, type SyncOutcome } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
import type { ItemsClassifyInput, SyncCommands } from '../protocol/sync.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { canvasApiUrl, canvasCourseId, type CanvasAssignmentValue, type GroupsStage, type TabsStage } from './canvas-api.js';
import { classificationRetryIds, type BuildDocumentResult } from './build-document.js';
import { resolvedChoices } from './conflicts.js';
import { CANVAS_ORIGIN } from './course-json.js';
import type { ResolvedChoices } from './grading.js';
import { handbookUrl } from './handbook.js';
import { ED_CLI_NOTE_STAGE, ED_CLI_NOT_USED } from './ed-cli.js';
import type { ExtensionReader } from './extension-bridge.js';
import { SyncJobs, runBoundMs } from './jobs.js';
import { allowedUrls, isAllowed, routeTabs, type AllowedUrls, type HomeLink } from './routing.js';

export { runBoundMs } from './jobs.js';

/** One agent job ends within 10 minutes or is interrupted and retried once. */
export const JOB_BOUND_MS = 10 * 60_000;
/** The most job records one Run keeps (`RunSchema.jobs`). */
const MAX_RUN_JOBS = 500;

/** The small jobs the code orchestrator runs in the layered pipeline. */
export type JobKind = 'courses' | 'handbook' | 'tabs' | 'groups' | 'main' | 'quizzes' | 'assignment' | 'saver' | 'ed' | 'classify';

/** One pipeline job: the code side decides its kind, course, allowed URLs and output stage. */
export interface JobSpec {
  kind: JobKind;
  jobId: string;
  courseKey?: string;
  urls: string[];
  /** The Canvas assignment id for `assignment` jobs (the stage key is per target). */
  target?: string;
  /** For a classification re-check: the item ids whose category the first pass left unknown. */
  retry?: string[];
}

/** The fixed stage each job kind must produce; `assignment` is per Canvas assignment. */
export const STAGE_BY_KIND = {
  courses: 'courses', handbook: 'skeleton', tabs: 'tabs', groups: 'groups', main: 'map',
  quizzes: 'quizzes', assignment: 'assignments.<target>', saver: 'materials', ed: 'ed', classify: 'classification',
} as const satisfies Record<JobKind, string>;

export function stageFor(spec: JobSpec): string {
  return spec.kind === 'assignment' ? `assignments.${spec.target ?? ''}` : STAGE_BY_KIND[spec.kind];
}

/** Per-course stage results as stored on the sync job. */
export type PipelineStages = Record<string, unknown>;

/** What a stage hook (folder archive, Ed CLI) may read for one course. */
export interface PipelineJobContext {
  jobId: string;
  courseKey: string;
  course: CourseSelection;
  stages: PipelineStages;
}

/** What a build may use besides the stages: the course, the check time, settled choices and blocked platforms. */
export interface PipelineBuildContext extends PipelineJobContext {
  now: string;
  resolved?: ResolvedChoices;
  blocked?: readonly ('canvas' | 'ed')[];
}

/**
 * The injected pipeline. 5.2/5.3 supply the prompts and tools; 6.2 supplies the document builder; 7.1/7.2 the hooks.
 * Production always passes it; there is no single-reading-job path.
 */
export interface SyncPipeline {
  prompt(spec: JobSpec, ctx?: PipelineJobContext): string;
  tools(spec: JobSpec): readonly AgentTool[];
  build(courseKey: string, stages: PipelineStages, context?: PipelineBuildContext): BuildDocumentResult | undefined;
  ed?(courseKey: string, ctx: PipelineJobContext): void | Promise<void>;
  archive?(courseKey: string, ctx: PipelineJobContext): void | Promise<void>;
  /** `sync.parallel`: at most this many routed jobs of one course run at once; default 1. */
  parallel?: number;
}

export interface AgentSyncOptions {
  extension?: ExtensionReader;
  store: SqliteRepository; jobs?: SyncJobs;
  /** Resolved per run, so the host can compose the adapter and the agent tools after the registry. */
  adapter: () => AgentAdapter;
  /** The layered per-course pipeline; production always runs it. */
  pipeline: SyncPipeline;
  /** Overrides the 10-minute per-job bound (tests). */
  jobBoundMs?: number;
  /** Overrides the computed 20-minute-per-course run bound (tests). */
  runBoundMs?: number;
  /** Historical name for `runBoundMs`; kept so existing callers still work. */
  timeoutMs?: number;
  now?: () => Date;
}
/** The plain JSON object shape stage results have after a round trip through the store. */
const jsonRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Missing plus unresolved counts from a course's archive stage; the stage's names and paths stay out of the Run. */
function missingFileCount(stage: unknown): number | undefined {
  const archive = jsonRecord(stage);
  if (!archive) return undefined;
  const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  const total = count(archive.missing) + count(archive.unresolved);
  return total > 0 ? total : undefined;
}

/** A stored `updatedAt` API field's found value; a plain ISO string is accepted for synthetic stages. */
function updatedAtOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const field = jsonRecord(value);
  return field?.state === 'found' && typeof field.value === 'string' ? field.value : undefined;
}

/** Whether a stored `assignments.<id>` stage holds a known (allowed or prohibited) policy. */
function knownPolicyStage(stage: unknown): boolean {
  const policy = jsonRecord(stage)?.policy;
  const value = typeof policy === 'string' ? policy : jsonRecord(policy)?.value;
  return value === 'allowed' || value === 'prohibited';
}

/** Find one assignment in a stored groups stage by Canvas id. */
function findAssignment(stage: unknown, id: string): Record<string, unknown> | undefined {
  const groups = jsonRecord(stage)?.groups;
  if (!Array.isArray(groups)) return undefined;
  for (const group of groups) {
    const assignments = jsonRecord(group)?.assignments;
    if (!Array.isArray(assignments)) continue;
    for (const assignment of assignments) {
      const row = jsonRecord(assignment);
      if (row !== undefined && String(row.id) === id) return row;
    }
  }
  return undefined;
}

const platforms = ['canvas', 'ed'] as const;

/** A stored classification stage's items, when the value has the shape `items.classify` wrote. */
function classificationItems(value: unknown): ItemsClassifyInput['items'] | undefined {
  const stage = jsonRecord(value);
  return stage && Array.isArray(stage.items) ? stage.items as ItemsClassifyInput['items'] : undefined;
}

/** Merge a retry into the first round by id; retry entries win and the first round's other answers stay. */
function mergeClassification(first: unknown, retry: unknown): { items: ItemsClassifyInput['items'] } | undefined {
  const before = classificationItems(first);
  const after = classificationItems(retry);
  if (!after) return before ? { items: before } : undefined;
  const byId = new Map((before ?? []).map(item => [item.id, item]));
  for (const item of after) byId.set(item.id, item);
  return { items: [...byId.values()] };
}

/**
 * A sync run is an agent job over the chat adapter (Codex by default). Only tool results count: the agent's commands
 * write to the store (from the `coursework mcp` process), and the Run is built from the store when the adapter ends.
 */
export class AgentSync implements SyncCommands {
  private readonly jobs: SyncJobs;
  constructor(private readonly options: AgentSyncOptions) { this.jobs = options.jobs ?? new SyncJobs(options.store, { now: options.now }); }
  private now(): Date { return this.options.now?.() ?? new Date(); }

  async run(input: { course?: string }): Promise<{ run: Run; outcome: SyncOutcome }> {
    if (input.course !== undefined && !/^[A-Z]{4}\d{5}$/.test(input.course)) throw new CourseworkError('INVALID_INPUT', 'Use a normalized course code.');
    const selected = this.jobs.candidates().filter(course => course.selected === true && (input.course === undefined || course.code === input.course));
    if (input.course !== undefined && !selected.length) throw new CourseworkError('INVALID_INPUT', 'Select this course before syncing it.');
    const job = this.jobs.open(selected.map(course => course.key));
    return this.pipelineRun(job, selected);
  }

  /**
   * The layered pipeline: list courses, then one course at a time through Handbook, Canvas API captures, the home page,
   * routed jobs, classification, build and import. Every URL is fixed for its kind or permitted by `allowedUrls`.
   */
  private async pipelineRun(job: SyncJob, selected: readonly CourseSelection[]) {
    const runner = new AgentJobRunner({ jobs: this.jobs, adapter: this.options.adapter,
      ...(this.options.jobBoundMs !== undefined ? { jobBoundMs: this.options.jobBoundMs } : {}) });
    const attempts: RunJob[] = [];
    const meta: PipelineMeta = { unavailableCourses: new Set(), sawError: false, coursesUnavailable: false };
    const controller = new AbortController();
    const bound = this.options.runBoundMs ?? this.options.timeoutMs ?? runBoundMs(selected.length);
    const timer = setTimeout(() => controller.abort(), bound);
    let steps = 0; let turns = 0;
    try {
      // A failed course list does not stop the run: previously selected courses are still processed.
      const started = performance.now();
      let reason: string | undefined;
      try {
        if (!this.options.extension) throw new Error('extension disconnected');
        const response = await this.options.extension.read(canvasApiUrl('courses'));
        if (response.status !== 200 || !response.finalUrl.startsWith(`${CANVAS_ORIGIN}/api/`)) throw new Error('signed out');
        this.jobs.capture({ jobId: job.id, page: 'courses', text: response.text });
      } catch (error) {
        meta.coursesUnavailable = true;
        reason = error instanceof Error ? error.message : 'extension read failed';
      }
      attempts.push({ kind: 'courses', via: 'extension', ms: Math.max(0, performance.now() - started),
        steps: 0, turns: 0, outcome: reason === undefined ? 'ok' : 'error', ...(reason === undefined ? {} : { reason }) });
      for (const course of selected) {
        if (controller.signal.aborted) break;
        const courseRun = await this.courseRun(runner, job, course, controller.signal, attempts, meta);
        steps += courseRun.steps; turns += courseRun.turns;
      }
    } catch { meta.sawError = true; }
    finally { clearTimeout(timer); }
    const failure: SyncOutcome | undefined = controller.signal.aborted ? 'TIMEOUT' : undefined;
    return this.finish(job, failure, turns, steps, { jobs: attempts, pipeline: meta });
  }

  /** One course, in D1 order. Everything a failed stage leaves out is simply absent from the stored stages. */
  private async courseRun(runner: AgentJobRunner, job: SyncJob, course: CourseSelection, signal: AbortSignal,
    attempts: RunJob[], meta: PipelineMeta): Promise<{ steps: number; turns: number }> {
    const pipeline = this.options.pipeline;
    let steps = 0; let turns = 0; let hadOk = false; let hadUnavailable = false; let hadError = false;
    const run = async (spec: JobSpec, produced?: (job: SyncJob) => boolean) => {
      // Read the stages just before this job starts, so the classifier sees what the course has produced so far.
      const result = await this.runStage(runner, spec, signal, attempts, meta, produced, this.stageContext(job, course));
      if (!result) return undefined;
      steps += result.steps; turns += result.turns;
      if (result.outcome === 'ok') hadOk = true;
      else if (result.unavailable) hadUnavailable = true;
      else hadError = true;
      return result;
    };
    const courseKey = course.key;

    await run({ kind: 'handbook', jobId: job.id, courseKey, urls: [handbookUrl(course.code, course.term)] });
    if (signal.aborted) return { steps, turns };

    const canvasId = course.pages.canvas ? canvasCourseId(course.pages.canvas) : undefined;
    if (canvasId) {
      await run({ kind: 'tabs', jobId: job.id, courseKey, urls: [canvasApiUrl('tabs', canvasId)] });
      if (signal.aborted) return { steps, turns };
      await run({ kind: 'groups', jobId: job.id, courseKey, urls: [canvasApiUrl('groups', canvasId)] });
      if (signal.aborted) return { steps, turns };
      // The main job reads only the course home page; the offer's page URL may point anywhere in the course.
      await run({ kind: 'main', jobId: job.id, courseKey, urls: [`${CANVAS_ORIGIN}/courses/${canvasId}`] });
      if (signal.aborted) return { steps, turns };
    }

    const routed = this.routedSpecs(job, course, canvasId);
    const limit = Math.max(1, Math.floor(pipeline.parallel ?? 1));
    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const spec = routed[next++];
        if (!spec) return;
        await run(spec);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, routed.length) }, () => worker()));
    if (signal.aborted) return { steps, turns };

    // The injected Ed hook (7.2) stores the CLI stage; when it stores nothing, one Ed page job reads Ed instead.
    if (pipeline.ed) {
      try { await pipeline.ed(courseKey, this.stageContext(job, course)); } catch { meta.sawError = true; }
      if (signal.aborted) return { steps, turns };
    }
    if (course.pages.ed && this.stageContext(job, course).stages.ed === undefined) {
      // Keep the "CLI not used" note in the job's stages (the Run schema has no note field); the fallback job is one job.
      try { this.jobs.recordStage(job.id, courseKey, ED_CLI_NOTE_STAGE, ED_CLI_NOT_USED); } catch { meta.sawError = true; }
      await run({ kind: 'ed', jobId: job.id, courseKey, urls: [course.pages.ed] });
      if (signal.aborted) return { steps, turns };
    }

    await run({ kind: 'classify', jobId: job.id, courseKey, urls: [] });
    if (signal.aborted) return { steps, turns };

    // The owner's settled choices for this course apply to this run's grading; the build also sees blocked platforms.
    const resolved = this.resolvedFor(courseKey);
    const blocked = this.jobs.load(job.id)?.blocked;
    const buildContext = (): PipelineBuildContext => ({ ...this.stageContext(job, course), now: this.now().toISOString(),
      ...(resolved ? { resolved } : {}), ...(blocked?.length ? { blocked } : {}) });
    const build = (): BuildDocumentResult | undefined => {
      // No stage at all means every job of this course failed: keep the course's previously stored data untouched.
      // The "CLI not used" note is run bookkeeping, not data, so it does not count.
      const builtFrom = this.stageContext(job, course).stages;
      if (!Object.keys(builtFrom).some(key => key !== ED_CLI_NOTE_STAGE)) return undefined;
      try { return pipeline.build(courseKey, builtFrom, buildContext()); } catch { meta.sawError = true; return undefined; }
    };
    let built = build();
    // One classification retry only, and only for ids the built document still leaves unknown.
    const retry = built !== undefined && 'document' in built ? classificationRetryIds(built) : [];
    if (retry.length && !signal.aborted) {
      const firstClassification = this.stageContext(job, course).stages.classification;
      await run({ kind: 'classify', jobId: job.id, courseKey, urls: [], retry });
      if (signal.aborted) return { steps, turns };
      // A retry may return only the re-checked ids; merge so the first round's other answers are not lost.
      const merged = mergeClassification(firstClassification, this.stageContext(job, course).stages.classification);
      if (merged) {
        try { this.jobs.recordStage(job.id, courseKey, 'classification', merged); } catch { meta.sawError = true; }
      }
      built = build();
    }
    if (built !== undefined) {
      // A build/import failure for one course is caught here; the course keeps its previously stored data.
      // Import and conflict reconciliation share one transaction inside `storeBuilt`.
      try { this.jobs.storeBuilt(job.id, built); } catch { meta.sawError = true; }
    } else if (!hadOk) meta.sawError = true;

    if (pipeline.archive) {
      try { await pipeline.archive(courseKey, this.stageContext(job, course)); } catch { meta.sawError = true; }
    }

    const stored = this.jobs.load(job.id)?.results?.[courseKey] !== undefined;
    // Only an all-unavailable course (no successful job and no generic failure) can make the run AGENT_UNAVAILABLE.
    if (!stored && !hadOk && hadUnavailable && !hadError) meta.unavailableCourses.add(courseKey);
    if (!stored && hadError) meta.sawError = true;
    return { steps, turns };
  }

  private stageContext(job: SyncJob, course: CourseSelection): PipelineJobContext {
    return { jobId: job.id, courseKey: course.key, course, stages: this.jobs.load(job.id)?.stages?.[course.key] ?? {} };
  }

  /** The owner's settled choices from earlier runs, so this run grades with them. */
  private resolvedFor(courseKey: string): ResolvedChoices | undefined {
    const courseId = this.jobs.courseIdFor(courseKey);
    return courseId === undefined ? undefined : resolvedChoices(this.options.store.listSyncConflicts(courseId));
  }

  /** The most recent earlier finished sync job of this course. */
  private previousFinishedJob(job: SyncJob, courseKey: string): SyncJob | undefined {
    return this.options.store.listSyncJobs()
      .filter(row => row.id !== job.id && row.endedAt !== undefined && row.courses.includes(courseKey))
      .sort((left, right) => Date.parse(right.endedAt!) - Date.parse(left.endedAt!))[0];
  }

  /**
   * An unchanged assignment page may be skipped when its API `updatedAt` equals the previous run's and that run
   * stored a known policy. The fingerprint half of the rule stays with the folder sync (7.1/5.2b).
   */
  private unchangedAssignment(previous: SyncJob | undefined, courseKey: string, assignment: CanvasAssignmentValue): boolean {
    const stage = previous?.stages?.[courseKey]?.[`assignments.${assignment.id}`];
    if (stage === undefined || !knownPolicyStage(stage)) return false;
    const previousGroups = previous?.stages?.[courseKey]?.groups;
    const before = updatedAtOf(findAssignment(previousGroups, assignment.id)?.updatedAt);
    const current = updatedAtOf(assignment.updatedAt);
    return before !== undefined && current !== undefined && before === current;
  }

  /**
   * Routed jobs after the home page. A job with no allowed URL is skipped. The grades tab stays in
   * `allowed.read` (the groups capture supplies the numbers) but is never handed to any job.
   */
  private routedSpecs(job: SyncJob, course: CourseSelection, canvasId: string | undefined): JobSpec[] {
    const stages = this.jobs.load(job.id)?.stages?.[course.key] ?? {};
    const tabs = stages.tabs as unknown as TabsStage | undefined;
    const routes = tabs ? routeTabs(tabs) : undefined;
    const allowed: AllowedUrls = routes ? allowedUrls(routes, this.homeLinks(stages.map), { courseId: canvasId }) : { read: [], save: [], link: [] };
    const specs: JobSpec[] = [];
    // The grades tab stays in `allowed.read` for the routing table, but Canvas numbers come from the groups stage.
    const grades = routes?.tabs.find(tab => tab.id === 'grades')?.url;
    const quiz = routes?.tabs.find(tab => tab.id === 'quizzes' && tab.route === 'read' && tab.url);
    if (quiz?.url && quiz.url !== grades && isAllowed(quiz.url, allowed)) {
      specs.push({ kind: 'quizzes', jobId: job.id, courseKey: course.key, urls: [quiz.url] });
    }
    const groups = stages.groups as unknown as GroupsStage | undefined;
    const previous = this.previousFinishedJob(job, course.key);
    const seen = new Set<string>();
    for (const group of groups?.groups ?? []) for (const assignment of group.assignments ?? []) {
      const url = assignment.htmlUrl;
      if (!url || seen.has(url) || !this.assignmentUrlAllowed(url, allowed, canvasId)) continue;
      seen.add(url);
      const stage = `assignments.${assignment.id}`;
      const previousStage = previous?.stages?.[course.key]?.[stage];
      if (previousStage !== undefined && this.unchangedAssignment(previous, course.key, assignment)) {
        // The skipped page's last known policy is carried into this run so the build still sees it.
        try { this.jobs.recordStage(job.id, course.key, stage, previousStage); continue; } catch { /* Fall back to a job. */ }
      }
      specs.push({ kind: 'assignment', jobId: job.id, courseKey: course.key, urls: [url], target: assignment.id });
    }
    if (allowed.save.length) specs.push({ kind: 'saver', jobId: job.id, courseKey: course.key, urls: [...allowed.save] });
    // Ed is not a routed job: the CLI hook runs after routing and the one fallback Ed job runs only when it stored nothing.
    // The grades tab stays in `allowed.read` for the routing table, but no routed job may open it.
    return grades ? specs.flatMap(spec => {
      const urls = spec.urls.filter(url => url !== grades);
      return urls.length ? [{ ...spec, urls }] : [];
    }) : specs;
  }

  private homeLinks(map: unknown): HomeLink[] {
    if (!map || typeof map !== 'object' || !Array.isArray((map as { links?: unknown }).links)) return [];
    return ((map as { links: unknown[] }).links).flatMap(link => {
      if (!link || typeof link !== 'object') return [];
      const { label, url } = link as { label?: unknown; url?: unknown };
      return typeof label === 'string' && typeof url === 'string' ? [{ label, url }] : [];
    });
  }

  /**
   * An assignment page is allowed as a `read` URL of the route table or because it is in this course's assignments
   * area. `save` and `link` URLs are never opened by an assignment job (a `link` target is recorded, not read).
   */
  private assignmentUrlAllowed(url: string, allowed: AllowedUrls, canvasId: string | undefined): boolean {
    if (allowed.read.includes(url)) return true;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== CANVAS_ORIGIN || parsed.username || parsed.password || /%2f|%5c/i.test(parsed.pathname)) return false;
      const match = /^\/courses\/(\d+)\/assignments(?:\/|$)/.exec(parsed.pathname);
      return match !== null && match[1] === canvasId;
    } catch { return false; }
  }

  /** One pipeline job through the Step 1 runner; the attempts are appended to the run's job record. */
  private async runStage(runner: AgentJobRunner, spec: JobSpec, signal: AbortSignal, attempts: RunJob[],
    meta: PipelineMeta, produced?: (job: SyncJob) => boolean, ctx?: PipelineJobContext): Promise<StageRun | undefined> {
    if (signal.aborted) return undefined;
    let prompt: string; let tools: readonly AgentTool[];
    try {
      prompt = this.options.pipeline.prompt(spec, ctx);
      tools = this.options.pipeline.tools(spec);
    } catch {
      // A bad injected prompt/tools fails this job like any adapter failure (one retry, two records).
      const failed: RunJob = { kind: spec.kind, ...(spec.courseKey !== undefined ? { courseKey: spec.courseKey } : {}), steps: 0, turns: 0, outcome: 'error' };
      attempts.push(failed, failed); meta.sawError = true;
      return { outcome: 'error', unavailable: false, steps: 0, turns: 0 };
    }
    const request: AgentJobRequest = { kind: spec.kind, jobId: spec.jobId,
      ...(spec.courseKey !== undefined ? { courseKey: spec.courseKey } : {}), prompt, tools, stage: stageFor(spec),
      ...(produced ? { produced } : {}) };
    const result = await runner.run(request, signal);
    attempts.push(...result.attempts);
    const steps = result.attempts.reduce((total, attempt) => total + attempt.steps, 0);
    const turns = result.attempts.reduce((total, attempt) => total + attempt.turns, 0);
    if (result.outcome !== 'ok' && !result.unavailable) meta.sawError = true;
    return { outcome: result.outcome, unavailable: result.unavailable === true, steps, turns };
  }

  private finish(job: SyncJob, failure: SyncOutcome | undefined, turns: number, steps: number,
    pipeline?: { jobs: RunJob[]; pipeline: PipelineMeta }) {
    return this.jobs.close(job.id, final => this.outcome(job, final, failure, turns, steps, pipeline))!;
  }
  /** Built from the job as read inside the closing transaction, so a late store write is never missed. */
  private outcome(job: SyncJob, final: SyncJob, failure: SyncOutcome | undefined, turns: number, steps: number,
    pipeline?: { jobs: RunJob[]; pipeline: PipelineMeta }) {
    const blocked = new Set(final.blocked ?? []);
    for (const result of Object.values(final.results ?? {})) for (const platform of platforms) if (result.platforms[platform] === 'blocked') blocked.add(platform);
    const nothingRead = !Object.keys(final.results ?? {}).length && platforms.every(platform => blocked.has(platform));
    // Every platform behind a sign-in page or unreadable (for example a locked screen) and nothing stored: the agent could not work.
    const outcome: SyncOutcome = failure ?? (nothingRead ? 'AGENT_UNAVAILABLE' : !final.courses.length
      ? pipeline?.pipeline.coursesUnavailable ? 'AGENT_UNAVAILABLE' : 'NEEDS_SELECTION'
      : this.storedOutcome(final, blocked, pipeline?.pipeline));
    const courseCoverage = final.courses.map(key => {
      const result = final.results?.[key];
      const state = (platform: 'canvas' | 'ed') => result?.platforms[platform] ?? (blocked.has(platform) ? 'blocked' as const : 'unread' as const);
      const groups = final.stages?.[key]?.groups as unknown as GroupsStage | undefined;
      const canvasNumbers = groups?.coverage === 'partial' ? 'partial' as const : groups?.coverage === 'api' ? 'api' as const : 'unavailable' as const;
      const missingFiles = missingFileCount(final.stages?.[key]?.archive);
      return { courseRef: createHash('sha256').update(`course:${key}`).digest('hex'), stored: result !== undefined, submissions: final.submissions[key] ?? 0,
        unknownFields: result?.unknownFields.length ?? 0, platforms: { canvas: state('canvas'), ed: state('ed') }, policyChanged: result?.policyChanged ?? false,
        ...(pipeline || groups ? { canvasNumbers } : {}), ...(missingFiles !== undefined ? { missingFiles } : {}) };
    });
    const ok = outcome === 'OK' || outcome === 'NEEDS_SELECTION';
    const run = RunSchema.parse({ id: job.id, command: 'sync', startedAt: job.startedAt, endedAt: this.now().toISOString(), steps,
      outcome: ok ? 'ok' : 'error', ...(ok ? {} : { errorCode: outcome }), turns, syncOutcome: outcome, courseCoverage,
      // `Run.jobs` holds at most 500 records; a run with more attempts keeps the first 500 so it can still close.
      ...(pipeline ? { jobs: pipeline.jobs.slice(0, MAX_RUN_JOBS) } : {}) });
    return { outcome, run, value: { run, outcome } };
  }

  private storedOutcome(final: SyncJob, blocked: ReadonlySet<'canvas' | 'ed'>, pipeline?: PipelineMeta): SyncOutcome {
    if (final.courses.every(key => final.results?.[key]) && blocked.size === 0) return 'OK';
    const stored = final.courses.filter(key => final.results?.[key]).length;
    if (stored === 0 && pipeline?.unavailableCourses.size && final.courses.every(key => pipeline.unavailableCourses.has(key))) return 'AGENT_UNAVAILABLE';
    if (stored === 0 && pipeline?.sawError) return 'FAILED';
    return 'PARTIAL';
  }

  status() {
    const jobs = this.options.store.listSyncJobs();
    const active = jobs.find(job => this.jobs.isActive(job));
    const ended = jobs.find(job => job.endedAt !== undefined);
    const runs = jobs.filter(job => job.endedAt !== undefined).map(job => this.options.store.loadRun(job.id)).filter((run): run is Run => run?.syncOutcome !== undefined)
      .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    const last = runs[0];
    const blocked = new Set(ended?.blocked ?? []);
    for (const result of Object.values(ended?.results ?? {})) for (const platform of platforms) if (result.platforms[platform] === 'blocked') blocked.add(platform);
    const selections = this.jobs.candidates();
    return {
      running: active !== undefined,
      ...(active ? { job: { id: active.id, startedAt: active.startedAt } } : {}),
      ...(last ? { lastRun: { id: last.id, startedAt: last.startedAt, endedAt: last.endedAt, outcome: last.syncOutcome!, turns: last.turns ?? 0, steps: last.steps } } : {}),
      blocked: platforms.filter(platform => blocked.has(platform)),
      undecided: selections.filter(row => row.selected === undefined).length,
      courses: selections.filter(row => row.selected === true).map(row => {
        const stored = jobs.find(job => job.results?.[row.key])?.results?.[row.key];
        const result = ended?.results?.[row.key];
        const missingFiles = missingFileCount(ended?.stages?.[row.key]?.archive);
        return { key: row.key, code: row.code, term: row.term, ...(row.name ? { name: row.name } : {}),
          ...(stored ? { courseId: stored.courseId, storedAt: stored.storedAt } : {}),
          ...(ended?.courses.includes(row.key) ? { lastRun: { stored: result !== undefined, unknownFields: result?.unknownFields ?? [], dropped: result?.dropped ?? [],
            warnings: result?.warnings ?? [], ...(result?.weightSum !== undefined ? { weightSum: result.weightSum } : {}), policyChanged: result?.policyChanged ?? false,
            ...(missingFiles !== undefined ? { missingFiles } : {}) } } : {}) };
      }),
    };
  }
}

/** One small pipeline job: its prompt, the tools it may use, and how its expected output is recognised. */
export interface AgentJobRequest {
  kind: string;
  /** The run's sync job id; tool calls write to this job in the `coursework mcp` process. */
  jobId: string;
  courseKey?: string;
  prompt: string;
  tools: readonly AgentTool[];
  /** The stage key in `stages[courseKey]` that proves the job wrote its output. */
  stage?: string;
  /** Custom success check for jobs that do not write one stage (for example the course list). */
  produced?: (job: SyncJob) => boolean;
}

export interface AgentJobRunnerOptions {
  jobs: SyncJobs;
  adapter: () => AgentAdapter;
  /** Overrides `JOB_BOUND_MS` (tests). */
  jobBoundMs?: number;
}

export interface AgentJobResult {
  outcome: RunJob['outcome'];
  /** One entry per attempt, including the single retry of a failed job. */
  attempts: RunJob[];
  /** True when the final attempt failed because the adapter reported the agent unavailable. */
  unavailable?: boolean;
}

/** The adapter's token totals for one attempt; absent when the adapter reports none (a timeout reports none). */
function tokensOf(event: { inputTokens?: number; outputTokens?: number }): Pick<RunJob, 'inputTokens' | 'outputTokens'> {
  return { ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
    ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}) };
}

/** How one pipeline stage ended, plus what it contributed to the run's totals. */
interface StageRun {
  outcome: RunJob['outcome'];
  unavailable: boolean;
  steps: number;
  turns: number;
}

/** Run-level facts the pipeline needs to choose an outcome without parsing agent text. */
interface PipelineMeta {
  /** Courses whose every attempted job was unavailable, with no successful job and no generic failure. */
  unavailableCourses: Set<string>;
  sawError: boolean;
  coursesUnavailable: boolean;
}

/**
 * Runs one agent job through one adapter start and retries a failure once. Only tool results count: a `result`
 * event without the expected stage, an `error` event, a thrown adapter or a timeout is a failure. The expected
 * stage is read back through SyncJobs because the agent's commands run in the separate `coursework mcp` process.
 *
 * Step 2 calls this from `AgentSync` for each pipeline job, passing the run's remaining time as `signal`.
 */
export class AgentJobRunner {
  constructor(private readonly options: AgentJobRunnerOptions) {}

  async run(request: AgentJobRequest, signal?: AbortSignal): Promise<AgentJobResult> {
    const attempts: RunJob[] = [];
    let unavailable = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attempt(request, signal);
      attempts.push(result.job);
      unavailable = result.unavailable;
      // A run that is ending does not start another attempt.
      if (result.job.outcome === 'ok' || signal?.aborted) break;
    }
    return { outcome: attempts.at(-1)!.outcome, attempts, ...(unavailable ? { unavailable: true } : {}) };
  }

  private async attempt(request: AgentJobRequest, signal?: AbortSignal): Promise<{ job: RunJob; unavailable: boolean }> {
    if (signal?.aborted) return { job: this.record(request, 0, 0, 'timeout'), unavailable: false };
    let steps = 0;
    let turns = 0;
    let usage: Pick<RunJob, 'inputTokens' | 'outputTokens'> = {};
    let unavailable = false;
    let failure: 'error' | 'timeout' | undefined;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const run = this.options.adapter().start({ prompt: request.prompt, tools: request.tools, transcript: [] });
      const events = run[Symbol.asyncIterator]();
      const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.options.jobBoundMs ?? JOB_BOUND_MS); });
      const aborted = signal ? new Promise<'aborted'>(resolve => {
        if (signal.aborted) { resolve('aborted'); return; }
        const listener = () => resolve('aborted');
        signal.addEventListener('abort', listener, { once: true });
        removeAbort = () => signal.removeEventListener('abort', listener);
      }) : undefined;
      while (true) {
        const next = await Promise.race([
          events.next().then(value => ({ kind: 'event' as const, value }), () => ({ kind: 'thrown' as const })),
          deadline,
          ...(aborted ? [aborted] : []),
        ]);
        if (next === 'timeout' || next === 'aborted') {
          failure ??= 'timeout';
          try { await run.interrupt(); } catch { /* The job is already stopped. */ }
          void Promise.resolve(events.return?.(undefined)).catch(() => {});
          break;
        }
        if (next.kind === 'thrown') { failure = 'error'; break; }
        if (next.value.done) break;
        // Events only count turns and steps; the agent's text is never parsed.
        const event: AgentEvent = next.value.value;
        if (event.type === 'tool_step') steps++;
        else if (event.type === 'result') { turns = event.turns; usage = tokensOf(event); finished = true; }
        else if (event.type === 'error') {
          turns = event.turns ?? turns; usage = tokensOf(event); failure ??= 'error';
          if (event.code === 'AGENT_UNAVAILABLE') unavailable = true;
        }
      }
    } catch { failure = 'error'; }
    finally { clearTimeout(timer); removeAbort?.(); }
    if (failure) return { job: { ...this.record(request, steps, turns, failure), ...usage }, unavailable: failure === 'error' && unavailable };
    if (!finished) return { job: { ...this.record(request, steps, turns, 'error'), ...usage }, unavailable: false };
    const job = this.options.jobs.load(request.jobId);
    return { job: { ...this.record(request, steps, turns, job && this.produced(request, job) ? 'ok' : 'error'), ...usage }, unavailable: false };
  }

  /** The store is the only proof: the expected stage, or the caller's check for jobs without one stage. */
  private produced(request: AgentJobRequest, job: SyncJob): boolean {
    if (request.produced) return request.produced(job);
    return request.courseKey !== undefined && request.stage !== undefined && job.stages?.[request.courseKey]?.[request.stage] !== undefined;
  }

  private record(request: AgentJobRequest, steps: number, turns: number, outcome: RunJob['outcome']): RunJob {
    return { kind: request.kind, ...(request.courseKey !== undefined ? { courseKey: request.courseKey } : {}), steps, turns, outcome };
  }
}
