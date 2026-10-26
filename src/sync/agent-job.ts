import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, AgentTool } from '../agent/adapter.js';
import { packageRoot } from '../config/data-dir.js';
import { RunSchema, type CourseSelection, type Run, type RunJob, type SyncJob, type SyncOutcome } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
import type { SyncCommands } from '../protocol/sync.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { courseDocumentJsonSchema } from './course-json.js';
import { SyncJobs, runBoundMs } from './jobs.js';

export { runBoundMs } from './jobs.js';

/** One agent job ends within 10 minutes or is interrupted and retried once. */
export const JOB_BOUND_MS = 10 * 60_000;
export interface AgentSyncOptions {
  store: SqliteRepository; jobs?: SyncJobs;
  /** Resolved per run, so the host can compose the adapter and the agent tools after the registry. */
  adapter: () => AgentAdapter; tools: () => readonly AgentTool[];
  /** Overrides the 10-minute per-job bound (tests). */
  jobBoundMs?: number;
  /** Overrides the computed 20-minute-per-course run bound (tests). */
  runBoundMs?: number;
  /** Historical name for `runBoundMs`; kept so existing callers still work. */
  timeoutMs?: number;
  now?: () => Date;
}
const melbourneDate = (instant: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
const platforms = ['canvas', 'ed'] as const;

/** The fixed reading prompt plus this job's id, selected courses, date and the course document JSON Schema. */
export function courseReadingPrompt(job: SyncJob, courses: readonly CourseSelection[], now: Date): string {
  const rules = readFileSync(join(packageRoot(), 'src', 'agent', 'course-reading.md'), 'utf8').trim();
  const selected = courses.length ? courses.map(course => `- ${course.key}: code ${course.code}, term ${course.term}`
    + `${course.name ? `, name ${JSON.stringify(course.name)}` : ''}, Canvas ${course.pages.canvas ?? 'unknown'}, Ed ${course.pages.ed ?? 'unknown'}`).join('\n')
    : '';
  return [rules, '', '## This job', '', `Job id: ${job.id}`, `Today: ${melbourneDate(now)} (Australia/Melbourne)`,
    courses.length ? `Selected courses (read each in full):\n${selected}` : 'Selected courses: none. Offer the courses you see, then stop.',
    '', '## Course document JSON Schema', '', '```json', JSON.stringify(courseDocumentJsonSchema()), '```', ''].join('\n');
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
    let turns = 0; let steps = 0; let failure: SyncOutcome | undefined;
    try {
      const run = this.options.adapter().start({ prompt: courseReadingPrompt(job, selected, this.now()), tools: this.options.tools(), transcript: [] });
      const events = run[Symbol.asyncIterator]();
      let timer: NodeJS.Timeout | undefined;
      const bound = this.options.runBoundMs ?? this.options.timeoutMs ?? runBoundMs(selected.length);
      const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), bound); });
      let finished = false;
      try {
        while (true) {
          const next = await Promise.race([events.next(), deadline]);
          if (next === 'timeout') {
            failure = 'TIMEOUT';
            await run.interrupt();
            void events.return?.(undefined)?.catch(() => {});
            break;
          }
          if (next.done) break;
          // Events only count turns and steps; the agent's text is never parsed.
          const event = next.value;
          if (event.type === 'tool_step') steps++;
          else if (event.type === 'result') { turns = event.turns; finished = true; }
          else if (event.type === 'error') { turns = event.turns ?? turns; failure = event.code === 'AGENT_UNAVAILABLE' ? 'AGENT_UNAVAILABLE' : 'FAILED'; }
        }
      } finally { clearTimeout(timer); }
      if (!failure && !finished) failure = 'FAILED';
    } catch { failure ??= 'FAILED'; }
    return this.finish(job, failure, turns, steps);
  }

  private finish(job: SyncJob, failure: SyncOutcome | undefined, turns: number, steps: number) {
    return this.jobs.close(job.id, final => this.outcome(job, final, failure, turns, steps))!;
  }
  /** Built from the job as read inside the closing transaction, so a late `course.import` is never missed. */
  private outcome(job: SyncJob, final: SyncJob, failure: SyncOutcome | undefined, turns: number, steps: number) {
    const blocked = new Set(final.blocked ?? []);
    for (const result of Object.values(final.results ?? {})) for (const platform of platforms) if (result.platforms[platform] === 'blocked') blocked.add(platform);
    const nothingRead = !Object.keys(final.results ?? {}).length && platforms.every(platform => blocked.has(platform));
    // Every platform behind a sign-in page or unreadable (for example a locked screen) and nothing stored: the agent could not work.
    const outcome: SyncOutcome = failure ?? (nothingRead ? 'AGENT_UNAVAILABLE' : !final.courses.length ? 'NEEDS_SELECTION'
      : final.courses.every(key => final.results?.[key]) && blocked.size === 0 ? 'OK' : 'PARTIAL');
    const courseCoverage = final.courses.map(key => {
      const result = final.results?.[key];
      const state = (platform: 'canvas' | 'ed') => result?.platforms[platform] ?? (blocked.has(platform) ? 'blocked' as const : 'unread' as const);
      return { courseRef: createHash('sha256').update(`course:${key}`).digest('hex'), stored: result !== undefined, submissions: final.submissions[key] ?? 0,
        unknownFields: result?.unknownFields.length ?? 0, platforms: { canvas: state('canvas'), ed: state('ed') }, policyChanged: result?.policyChanged ?? false };
    });
    const ok = outcome === 'OK' || outcome === 'NEEDS_SELECTION';
    const run = RunSchema.parse({ id: job.id, command: 'sync', startedAt: job.startedAt, endedAt: this.now().toISOString(), steps,
      outcome: ok ? 'ok' : 'error', ...(ok ? {} : { errorCode: outcome }), turns, syncOutcome: outcome, courseCoverage });
    return { outcome, run, value: { run, outcome } };
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
        return { key: row.key, code: row.code, term: row.term, ...(row.name ? { name: row.name } : {}),
          ...(stored ? { courseId: stored.courseId, storedAt: stored.storedAt } : {}),
          ...(ended?.courses.includes(row.key) ? { lastRun: { stored: result !== undefined, unknownFields: result?.unknownFields ?? [], dropped: result?.dropped ?? [],
            warnings: result?.warnings ?? [], ...(result?.weightSum !== undefined ? { weightSum: result.weightSum } : {}), policyChanged: result?.policyChanged ?? false } } : {}) };
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.attempt(request, signal);
      attempts.push(result);
      // A run that is ending does not start another attempt.
      if (result.outcome === 'ok' || signal?.aborted) break;
    }
    return { outcome: attempts.at(-1)!.outcome, attempts };
  }

  private async attempt(request: AgentJobRequest, signal?: AbortSignal): Promise<RunJob> {
    if (signal?.aborted) return this.record(request, 0, 0, 'timeout');
    let steps = 0;
    let turns = 0;
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
        else if (event.type === 'result') { turns = event.turns; finished = true; }
        else if (event.type === 'error') { turns = event.turns ?? turns; failure ??= 'error'; }
      }
    } catch { failure = 'error'; }
    finally { clearTimeout(timer); removeAbort?.(); }
    if (failure) return this.record(request, steps, turns, failure);
    if (!finished) return this.record(request, steps, turns, 'error');
    const job = this.options.jobs.load(request.jobId);
    return this.record(request, steps, turns, job && this.produced(request, job) ? 'ok' : 'error');
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
