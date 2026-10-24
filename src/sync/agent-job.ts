import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentTool } from '../agent/adapter.js';
import { packageRoot } from '../config/data-dir.js';
import { RunSchema, type CourseSelection, type Run, type SyncJob, type SyncOutcome } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
import type { SyncCommands } from '../protocol/sync.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { courseDocumentJsonSchema } from './course-json.js';
import { SyncJobs } from './jobs.js';

/** A run ends within 20 minutes or is stopped and recorded as TIMEOUT. */
export const RUN_BOUND_MS = 20 * 60_000;
export interface AgentSyncOptions {
  store: SqliteRepository; jobs?: SyncJobs;
  /** Resolved per run, so the host can compose the adapter and the agent tools after the registry. */
  adapter: () => AgentAdapter; tools: () => readonly AgentTool[];
  timeoutMs?: number; now?: () => Date;
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
      const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.options.timeoutMs ?? RUN_BOUND_MS); });
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
