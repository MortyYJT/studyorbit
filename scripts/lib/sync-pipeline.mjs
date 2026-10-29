// The staged course sync (openspec change local-server-sync-pipeline, design §6-§10, decisions #345-#349): jobs in
// the sync store, four stages per course with checkpoints, resume from checkpoints, cancellation and interruption,
// per-platform limiters. Every side effect is a constructor dependency: the server passes the real ones, tests pass
// fake collectors, a fake model, a manual clock and hooks. Hooks exist only as this constructor parameter.
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { courseOutputSchema } from './course-analysis.mjs';
import { recordCourseChanges } from './course-changes-log.mjs';
import { filterSubjects } from './course-list.mjs';
import { configProblem, resolveAnalysisConfig } from './llm-config.mjs';
import { analyse, counts } from './llm-providers.mjs';
import { createLimiter, systemClock } from './rate-limit.mjs';
import { LINEAGE_ANCESTORS } from './sync-store.mjs';
import { LEGACY_SOURCE_IDS, resolveSourceSetup } from '../sources/registry.mjs';
import {
  analyseStage, captureEarlierDocument, collectStage, mergeStage, REASONS, spawnCollector, STAGES, StageFailure, validateStage,
} from './sync-stages.mjs';

export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MODEL_CONCURRENCY = 4;
export const COLLECTOR_INTERVAL_MS = 500;
const RESUMABLE = new Set(['failed', 'cancelled', 'interrupted']);
const ZERO_USAGE = Object.freeze({ input: 0, cached: 0, output: 0, reasoning: 0 });

/** Thrown by a test hook to simulate the death of the server process at that point (design §10). */
export class SimulatedCrash extends Error {
  constructor(message = 'simulated crash') { super(message); this.name = 'SimulatedCrash'; }
}

/**
 * Limiters (design §9): one collector limiter per key, one at a time with 500 ms between starts. Every source that
 * uses the browser (Canvas and the Handbook) has the key `browser`, so they never overlap; Ed has `ed`. One limiter
 * per model provider, four at a time.
 */
export function createSyncLimiters({ clock = systemClock, random = Math.random } = {}) {
  const collectors = new Map();
  const models = new Map();
  return {
    collect(key) {
      if (!collectors.has(key)) collectors.set(key, createLimiter({ concurrency: 1, minIntervalMs: COLLECTOR_INTERVAL_MS, clock, random }));
      return collectors.get(key);
    },
    model(provider) {
      if (!models.has(provider)) models.set(provider, createLimiter({ concurrency: MODEL_CONCURRENCY, clock, random }));
      return models.get(provider);
    },
  };
}

/** Codex subagent usage from `~/.codex/sessions` for the coordinator thread `parentId` (unchanged from the runner). */
export async function codexChildUsage(parentId, start) {
  if (!parentId) return null;
  const dates = new Set([start, new Date()].map(date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('/')));
  const records = [];
  for (const day of dates) {
    const dir = join(homedir(), '.codex', 'sessions', day);
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter(item => item.endsWith('.jsonl'))) {
      let stream;
      try {
        stream = createInterface({ input: createReadStream(join(dir, name)), crlfDelay: Infinity });
        let first = true, matched = false, latest = null;
        for await (const line of stream) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (first) {
            first = false;
            matched = event?.payload?.source?.subagent?.thread_spawn?.parent_thread_id === parentId;
            if (!matched) break;
          }
          if (event?.payload?.type === 'token_count') latest = counts(event.payload.info?.total_token_usage) ?? latest;
        }
        if (matched && latest) records.push(latest);
      } catch { /* A missing or inaccessible log is recorded as unavailable. */ } finally { stream?.close(); }
    }
  }
  if (!records.length) return null;
  return records.reduce((a, b) => ({ input: a.input + b.input, cached: a.cached === null || b.cached === null ? null : a.cached + b.cached,
    output: a.output + b.output, reasoning: a.reasoning === null || b.reasoning === null ? null : a.reasoning + b.reasoning }),
  { input: 0, cached: 0, output: 0, reasoning: 0 });
}

const codeError = code => new Error(code);

/**
 * `deps`: `store` (an open sync store), `projectDir`, `desktopDir`, and optionally `env`, `setup` (settings,
 * institution, sources and source context; default today's UniMelb setup), `sources` (replaces the setup's sources,
 * for tests), `runCollector`, `callModel`, `resolveModel`, `childUsage`, `clock` ({ now, sleep }), `random`,
 * `limiters`, `hooks` ({ beforeStage, afterCheckpoint, afterMergeWrite }) and `newId`.
 */
export function createSyncPipeline(deps) {
  const {
    store: rawStore, projectDir, desktopDir, env = process.env, runCollector = spawnCollector, callModel = analyse,
    childUsage = codexChildUsage, clock = systemClock, random = Math.random, hooks = {}, newId = randomUUID,
  } = deps;
  const baseSetup = deps.setup ?? resolveSourceSetup();
  const setup = deps.sources ? { ...baseSetup, sources: deps.sources } : baseSetup;
  const { institution } = setup;
  /** The source objects of stored ids (a job created before ids were stored used the three UniMelb sources). */
  const sourcesFor = ids => (ids ?? LEGACY_SOURCE_IDS).map(id => {
    const source = setup.sources.find(item => item.id === id);
    if (!source) throw codeError('SOURCES_CHANGED');
    return source;
  });
  const resolveModel = deps.resolveModel ?? (() => resolveAnalysisConfig(projectDir, env));
  const limiters = deps.limiters ?? createSyncLimiters({ clock, random });
  const usagePath = join(projectDir, '.local', 'lms', 'course-sync-usage.jsonl');
  const schemaPath = join(projectDir, '.local', 'lms', 'course-output.schema.json');
  const diagnosticDir = join(projectDir, '.local', 'lms', 'sync-errors');
  const isoNow = () => new Date(clock.now()).toISOString();

  // A simulated crash halts the whole instance: no store or file write takes effect afterwards (design §10).
  let halted = false;
  const assertAlive = () => { if (halted) throw new Error('PIPELINE_HALTED'); };
  const store = new Proxy(rawStore, {
    get(target, key) {
      const value = target[key];
      return typeof value === 'function' ? (...args) => { assertAlive(); return value.apply(target, args); } : value;
    },
  });
  const io = {
    async mkdir(path, options) { assertAlive(); return mkdir(path, options); },
    async writeFile(path, data, options) { assertAlive(); return writeFile(path, data, options); },
    async appendFile(path, data, options) { assertAlive(); return appendFile(path, data, options); },
    async recordCourseChanges(entry, row) { assertAlive(); return recordCourseChanges(projectDir, entry, row, { beforeWrite: assertAlive }); },
  };

  let current = null; // { jobId, controller, stops, stop: null | 'cancelled' | 'interrupted' }
  let reserving = false;
  // A cancel or shutdown that arrives while a start or resume is being prepared applies to the job it creates.
  let pendingStop = null;
  let reservation = Promise.resolve();
  let idle = Promise.resolve();

  function halt() {
    if (halted) return;
    halted = true;
    if (current) stopCurrent('interrupted');
  }
  async function hook(name, ...args) {
    try { await hooks[name]?.(...args); }
    catch (error) { if (error instanceof SimulatedCrash) halt(); throw error; }
  }
  function stopCurrent(status) {
    if (!current) return;
    current.stop ??= status;
    current.controller.abort();
    for (const stop of [...current.stops]) { try { stop(); } catch { /* Already stopped. */ } }
  }

  // ---- Status -------------------------------------------------------------------------------------------------
  function courseDone(jobId, courseId) {
    return rawStore.lineageStages(jobId, courseId, 'merge').find(row => row.status === 'succeeded') ?? null;
  }
  function resumeProblem(job) {
    if (!RESUMABLE.has(job.status)) return 'NOT_RESUMABLE';
    if (rawStore.childOf(job.id)) return 'ALREADY_RESUMED';
    // The age is the lineage root's: ancestors' collected data can be reused (design §7).
    let root = job, length = 1;
    while (root?.resumedFrom && length <= LINEAGE_ANCESTORS + 1) { root = rawStore.getJob(root.resumedFrom); length++; }
    if (!root || clock.now() - Date.parse(root.createdAt) >= RESUME_WINDOW_MS) return 'RESUME_EXPIRED';
    // A resumed job sees itself plus LINEAGE_ANCESTORS ancestors; past that, the root's merged courses and change-log
    // lines would be invisible and done courses would run again (decision #431).
    if (length > LINEAGE_ANCESTORS) return 'NOT_RESUMABLE';
    if (job.courses.every(course => courseDone(job.id, course.courseId))) return 'NOT_RESUMABLE';
    return null;
  }
  const isRunning = jobId => Boolean(current && current.jobId === jobId);
  function latestStage(jobId, courseId) {
    let stage = null;
    for (const name of STAGES) if (rawStore.getStage(jobId, courseId, name)) stage = name;
    return stage;
  }
  function status() {
    const job = rawStore.newestJob();
    if (!job) return { running: false, courses: [], error: null, jobId: null, resumable: false };
    const running = isRunning(job.id);
    return {
      running,
      courses: job.courses.map(course => ({
        id: course.courseId, code: course.code ?? '', status: course.status, reason: course.reason ?? '',
        ...(course.phase ? { phase: course.phase } : {}), ...(course.file ? { file: course.file } : {}),
        stage: latestStage(job.id, course.courseId), reused: course.reused,
      })),
      error: job.error, jobId: job.id, resumedFrom: job.resumedFrom, resumable: !running && !current && !reserving && resumeProblem(job) === null,
    };
  }
  function jobs() {
    return rawStore.listJobs().map(job => ({
      id: job.id, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt, resumedFrom: job.resumedFrom,
      resumable: !isRunning(job.id) && !current && !reserving && resumeProblem(job) === null,
      courses: job.courses.map(course => ({ id: course.courseId, code: course.code ?? '', status: course.status })),
    }));
  }

  // ---- Start and resume -----------------------------------------------------------------------------------------
  async function prepare() {
    const config = await resolveModel();
    const problem = configProblem(config);
    if (problem) throw codeError(problem);
    let input;
    try { input = JSON.parse(await readFile(join(projectDir, '.local', 'lms', 'courses.json'), 'utf8')); }
    catch { throw codeError('COURSES_UNAVAILABLE'); }
    if (!Array.isArray(input?.courses)) throw codeError('COURSES_UNAVAILABLE');
    const candidates = filterSubjects(input.courses.filter(item => item && typeof item.id === 'string'), institution).filter(item => institution.isSubjectCode(item.subjectCode));
    return { config, candidates };
  }
  async function begin(action) {
    if (current || reserving) throw codeError('SYNC_RUNNING');
    if (halted) throw codeError('PIPELINE_HALTED');
    reserving = true;
    pendingStop = null;
    const work = action();
    reservation = work.then(() => {}, () => {});
    try { return await work; } finally { reserving = false; pendingStop = null; }
  }

  async function start(ids) {
    return begin(async () => {
      const { config, candidates } = await prepare();
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw codeError('INVALID_SELECTION');
      const selected = ids.map(id => candidates.find(item => item.id === id));
      if (selected.some(item => !item)) throw codeError('INVALID_SELECTION');
      const jobId = newId();
      // The earlier document of each course is captured once per lineage, before anything runs (decision #354).
      const courses = [];
      for (const course of selected) {
        courses.push({ courseId: course.id, code: course.subjectCode, term: typeof course.term === 'string' ? course.term : null,
          previous: await captureEarlierDocument(store, desktopDir, course, institution) });
      }
      return launch({ jobId, config, selected, courses, resumedFrom: null, sourceIds: setup.sources.map(source => source.id) });
    });
  }

  async function resume(jobId) {
    return begin(async () => {
      const parent = rawStore.getJob(jobId);
      if (!parent) throw codeError('JOB_NOT_FOUND');
      const problem = resumeProblem(parent);
      if (problem) throw codeError(problem);
      // A resume runs the parent's sources, so its checkpoints and hashes keep matching.
      const sourceIds = (parent.sources ?? LEGACY_SOURCE_IDS).slice();
      sourcesFor(sourceIds);
      const { config, candidates } = await prepare();
      const selected = parent.courses.map(course => candidates.find(item => item.id === course.courseId) ?? null);
      const courses = parent.courses.map((course, index) => ({
        courseId: course.courseId, code: selected[index]?.subjectCode ?? course.code, term: selected[index] ? (typeof selected[index].term === 'string' ? selected[index].term : null) : course.term,
        previous: course.previous,
      }));
      return launch({ jobId: newId(), config, selected, courses, resumedFrom: parent.id, sourceIds });
    });
  }

  async function launch({ jobId, config, selected, courses, resumedFrom, sourceIds }) {
    await io.mkdir(dirname(schemaPath), { recursive: true });
    await io.writeFile(schemaPath, JSON.stringify(courseOutputSchema(), null, 2), { mode: 0o600 });
    store.createJob({ id: jobId, provider: config.provider, model: config.model, resumedFrom, sources: sourceIds, courses });
    const startedAt = clock.now();
    try {
      await appendUsage({ type: 'batch_start', runId: jobId, at: new Date(startedAt).toISOString(), courses: courses.map(course => course.code),
        ...(resumedFrom ? { resumedFrom } : {}) });
    } catch (error) {
      safely(() => {
        for (const course of courses) store.updateCourse(jobId, course.courseId, { status: 'failed', reason: '同步记录保存失败。' });
        store.updateJob(jobId, { status: 'failed', finishedAt: isoNow(), error: '同步记录保存失败。' });
      });
      throw error;
    }
    const controller = new AbortController();
    current = { jobId, controller, stops: new Set(), stop: null };
    const job = current;
    if (pendingStop) {
      if (pendingStop === 'cancelled') cancel(); else stopCurrent(pendingStop);
    }
    // runJob reports its own failures through the job row; a rejection here (store closed under it) is not fatal.
    idle = runJob(job, config, selected, startedAt).catch(() => {}).finally(() => {
      if (halted) { try { rawStore.close(); } catch { /* Already closed. */ } }
      if (current === job) current = null;
    });
    return status();
  }

  // ---- Running a job ----------------------------------------------------------------------------------------------
  async function appendUsage(line) {
    await io.mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
    await io.appendFile(usagePath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  async function runJob(job, config, selected, startedAt) {
    const jobId = job.jobId;
    const lineageIds = rawStore.lineage(jobId);
    const ctx = {
      store, io, projectDir, desktopDir, jobId, lineageIds, config, limiters, runCollector, callModel, childUsage,
      institution, sources: sourcesFor(rawStore.getJob(jobId).sources), sourceContext: setup.context,
      schema: courseOutputSchema(), schemaPath, signal: job.controller.signal,
      registerStop(stop) {
        job.stops.add(stop);
        if (job.stop) stop();
        return () => job.stops.delete(stop);
      },
      stopStatus: () => job.stop,
      halted: () => halted,
      assertAlive, hook, isoNow, now: () => clock.now(),
      setCourse: (courseId, patch) => store.updateCourse(jobId, courseId, patch),
      async writeDiagnostic(name, value) {
        await io.mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
        await io.writeFile(join(diagnosticDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
      },
    };
    const stored = rawStore.getJob(jobId);
    const tasks = [];
    let failure = null;
    try {
      for (const [index, row] of stored.courses.entries()) {
        if (halted) break;
        const course = selected[index];
        if (job.stop) { safely(() => markStopped(job, row.courseId)); continue; }
        const merged = courseDone(jobId, row.courseId);
        if (merged) {
          try { await copyDone(ctx, row, merged); } catch {
            if (halted) break;
            safely(() => store.updateCourse(jobId, row.courseId, { status: 'failed', reason: REASONS.stageUnexpected }));
          }
          continue;
        }
        if (!course) {
          store.updateCourse(jobId, row.courseId, { status: 'failed', reason: REASONS.courseRemoved });
          continue;
        }
        const started = clock.now();
        store.updateCourse(jobId, course.id, { status: 'running', phase: 'starting' });
        let collected;
        try {
          collected = await collectStage(ctx, course);
        } catch (error) {
          if (halted) break;
          await courseStopped(ctx, course, error, started, { phases: error?.phases ?? {}, reused: [], stage: 'collect' });
          continue;
        }
        store.updateCourse(jobId, course.id, { phase: 'waiting_analysis' });
        tasks.push(courseTask(ctx, course, row, collected, started));
      }
    } catch (error) {
      if (!halted) failure = error;
    }
    await Promise.allSettled(tasks);
    if (halted) return;
    await finish(job, startedAt, failure);
  }

  function markStopped(job, courseId) {
    const course = rawStore.getJob(job.jobId).courses.find(item => item.courseId === courseId);
    if (course && (course.status === 'pending' || course.status === 'running')) store.updateCourse(job.jobId, courseId, { status: job.stop });
  }
  function safely(fn) { try { return fn(); } catch { return undefined; } }

  /** A course merged earlier in the lineage: copied as done, nothing runs, no tokens. */
  async function copyDone(ctx, row, merged) {
    const source = rawStore.getJob(merged.jobId).courses.find(course => course.courseId === row.courseId);
    let outcome = { status: source?.status, reason: source?.reason ?? '', file: source?.file ?? null };
    if (!['completed', 'partial', 'failed'].includes(outcome.status)) {
      // The server died between the merge commit and the course row update: take the result from the checkpoint.
      const checkpoint = merged.checkpoint;
      const validated = typeof checkpoint.status === 'string' ? checkpoint : JSON.parse(rawStore.getArtifact(checkpoint.validateArtifact));
      outcome = { status: validated.status, reason: validated.reason ?? '', file: checkpoint.plannedPath ?? null };
    }
    ctx.store.updateCourse(ctx.jobId, row.courseId, { ...outcome, reused: true, phase: null });
    await writeCourseUsage(ctx, { code: row.code, status: outcome.status, started: clock.now(), phases: {}, coordinator: { ...ZERO_USAGE }, subagents: null, reused: [...STAGES] }, row.courseId);
  }

  async function courseTask(ctx, course, row, collected, started) {
    const reused = collected.reused ? ['collect'] : [];
    const phases = { ...collected.phases };
    let usage = null, stage = 'analyse';
    try {
      const analysed = await analyseStage(ctx, course, collected);
      if (analysed.reused) { reused.push('analyse'); usage = { coordinator: { ...ZERO_USAGE }, subagents: null }; }
      else { usage = analysed.usage; phases.analysisMs = analysed.durationMs; }
      stage = 'validate';
      const validated = await validateStage(ctx, course, collected, analysed, row.previous);
      if (validated.reused) reused.push('validate');
      stage = 'merge';
      const merged = await mergeStage(ctx, course, validated, row.previous);
      ctx.store.updateCourse(ctx.jobId, course.id, { status: merged.status, reason: merged.reason, file: merged.file, stoppedStage: null });
      await writeCourseUsage(ctx, { code: course.subjectCode, status: merged.status, started, phases, coordinator: usage?.coordinator ?? null, subagents: usage?.subagents ?? null, reused }, course.id);
    } catch (error) {
      if (halted) return;
      await courseStopped(ctx, course, error, started, { phases, reused, usage: error?.usage ?? usage, stage });
    }
  }

  /** A stopped course: `failed` with the stage and reason, or cancelled/interrupted; one usage line. */
  async function courseStopped(ctx, course, error, started, { phases, reused, usage, stage }) {
    if (halted) return;
    // An error outside a stage's work (reading collected files, a store write) counts against the stage it preceded.
    const failure = error instanceof StageFailure ? error : new StageFailure({ stage, status: ctx.stopStatus() ?? 'failed', code: 'UNEXPECTED',
      reason: ctx.stopStatus() ? '' : stage === 'collect' ? REASONS.collectUnexpected : REASONS.stageUnexpected });
    const status = failure.status === 'failed' ? 'failed' : failure.status;
    safely(() => ctx.store.updateCourse(ctx.jobId, course.id, { status, reason: failure.reason ?? '', stoppedStage: status === 'failed' ? failure.stage : null }));
    await writeCourseUsage(ctx, { code: course.subjectCode, status, started, phases, coordinator: usage?.coordinator ?? null, subagents: usage?.subagents ?? null, reused }, course.id);
  }

  /** One usage line per course per job; a write failure adds 「用量记录写入失败。」 to the reason as before. */
  async function writeCourseUsage(ctx, { code, status, started, phases, coordinator, subagents, reused }, courseId) {
    if (halted) return;
    try {
      await appendUsage({ runId: ctx.jobId, at: new Date(started).toISOString(), course: code, model: ctx.config.model, durationMs: clock.now() - started,
        status, phases, coordinator, subagents, ...(reused.length ? { reused } : {}) });
    } catch {
      if (halted) return;
      safely(() => {
        const row = rawStore.getJob(ctx.jobId).courses.find(item => item.courseId === courseId);
        ctx.store.updateCourse(ctx.jobId, courseId, { reason: `${row?.reason ?? ''} 用量记录写入失败。` });
      });
    }
  }

  async function finish(job, startedAt, failure) {
    const jobId = job.jobId;
    let error = failure ? '同步任务异常中断，请检查本地环境。' : null;
    safely(() => {
      for (const course of rawStore.getJob(jobId).courses) {
        if (course.status === 'pending' || course.status === 'running') store.updateCourse(jobId, course.courseId, { status: job.stop ?? 'failed' });
      }
    });
    const final = safely(() => rawStore.getJob(jobId));
    try {
      await appendUsage({ type: 'batch_end', runId: jobId, at: isoNow(), durationMs: clock.now() - startedAt,
        courses: (final?.courses ?? []).map(({ code, status }) => ({ code, status })) });
    } catch { error ??= '同步记录保存失败。'; }
    const stoppedCourse = final?.courses.some(course => course.stoppedStage) ?? true;
    const status = job.stop ?? (failure || stoppedCourse ? 'failed' : 'finished');
    safely(() => store.updateJob(jobId, { status, finishedAt: isoNow(), error }));
  }

  // ---- Stopping ---------------------------------------------------------------------------------------------------
  /** DELETE: pending and running courses become `cancelled` at once; every stop is called; waits end immediately. */
  function cancel() {
    if (!current) {
      if (reserving) pendingStop ??= 'cancelled';
      return status();
    }
    const job = current;
    if (!job.stop) {
      job.stop = 'cancelled';
      safely(() => {
        for (const course of rawStore.getJob(job.jobId).courses) {
          if (course.status === 'pending' || course.status === 'running') store.updateCourse(job.jobId, course.courseId, { status: 'cancelled' });
        }
      });
    }
    stopCurrent('cancelled');
    return status();
  }

  /** Server shutdown: stop as for cancel, but mark the work `interrupted`. Resolves when the job's tasks settled. */
  function shutdown() {
    if (current) { stopCurrent('interrupted'); return idle; }
    if (reserving) { pendingStop = 'interrupted'; return reservation.then(() => idle); }
    return idle;
  }

  return {
    start, resume, cancel, shutdown, status, jobs,
    /** True while a job runs or a start or resume is being prepared. */
    running: () => Boolean(current) || reserving,
    /** Resolves after the current job and all its tasks have settled. */
    idle: () => idle,
  };
}
