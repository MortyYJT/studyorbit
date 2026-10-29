// The four stages of a course sync — collect, analyse, validate, merge — with their checkpoints in the sync store
// (design §6, decisions #345, #353, #354). Each stage has an input hash (sha256 of a canonical JSON of its inputs and
// a version constant), runs or reuses a checkpoint of the job's lineage, and records a `stages` row. The pipeline
// (sync-pipeline.mjs) orders the stages, runs the jobs and owns cancellation; everything here receives its side
// effects through `ctx` so a simulated crash can stop every later write.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAnalysisPrompt } from './course-analysis.mjs';
import { changeLogHasRun } from './course-changes-log.mjs';
import { newestCourseDocument } from './course-reports.mjs';
import { analyseWithRepair, settleCourse, validateAnalysis } from './course-validation.mjs';
import { EX_TEMPFAIL } from './collector-exit.mjs';
import { isTemporaryFailure } from './llm-providers.mjs';

/** Bump a stage's version whenever its code changes meaning: older checkpoints then stop matching. */
export const COLLECT_VERSION = 1;
export const ANALYSE_VERSION = 1;
export const VALIDATE_VERSION = 1;
export const MERGE_VERSION = 1;
export const STAGES = Object.freeze(['collect', 'analyse', 'validate', 'merge']);
export const SOURCES = Object.freeze(['canvas', 'ed', 'handbook']);

const SOURCE_LABELS = { canvas: 'Canvas', ed: 'Ed', handbook: 'Handbook' };
// The placeholders written when a collector fails, byte for byte as before the staged pipeline.
const PLACEHOLDERS = {
  canvas: JSON.stringify({ status: 'unavailable', reason: 'Canvas 采集不可用' }),
  ed: JSON.stringify({ status: 'unavailable', lessons: [], scores: [], reason: 'Ed 采集不可用' }),
  handbook: JSON.stringify({ status: 'unavailable', reason: 'Handbook 采集不可用' }),
};
export const REASONS = Object.freeze({
  collectUnexpected: '无法启动或记录课程任务，请检查本地环境。',
  stageUnexpected: '课程分析或保存失败，请检查本地环境。',
  modelFailed: '模型任务未正常完成，请检查模型配置及连接。',
  mergeTargetChanged: '计划写入的课程文件已被修改，未覆盖；请重新同步这门课。',
  courseRemoved: '课程已不在课程列表中',
});

/** JSON with object keys sorted at every level (undefined values dropped), so equal inputs hash equally. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
export const sha256Hex = data => createHash('sha256').update(data).digest('hex');
export const hashOf = value => sha256Hex(canonicalJson(value));

export const collectInputHash = ({ courseId, code, term }) => hashOf({ stage: 'collect', version: COLLECT_VERSION, courseId, code, term });
/** Covers the prompt (collected data and schema included), provider, model and base URL — never the key. */
export const analyseInputHash = ({ prompt, config }) => hashOf({
  stage: 'analyse', version: ANALYSE_VERSION, prompt, provider: config.provider, model: config.model ?? null, baseUrl: config.baseUrl ?? null,
});
export const validateInputHash = ({ analyseArtifact, sources, previous }) => hashOf({
  stage: 'validate', version: VALIDATE_VERSION, analyse: analyseArtifact, previous: previous ?? 'none',
  sources: Object.fromEntries(SOURCES.map(source => [source, { sha256: sources[source].sha256, exitCode: sources[source].exitCode }])),
});
export const mergeInputHash = ({ validateArtifact, courseDir }) => hashOf({ stage: 'merge', version: MERGE_VERSION, validate: validateArtifact, courseDir });

/** Desktop folder label for a Canvas term, e.g. "2026 S2" (same rule as course-reports). */
export function termLabel(term) {
  const value = typeof term === 'string' ? term : '';
  const match = /(20\d{2}).*?(?:semester|sem)\s*([12])/i.exec(value);
  return match ? `${match[1]} S${match[2]}` : value.replace(/[^\w\u4e00-\u9fff -]/g, '').trim().slice(0, 50) || '未知学期';
}
export const courseTerm = course => (typeof course.term === 'string' ? course.term : '');
export const courseFolder = (desktopDir, course) => join(desktopDir, `墨尔本大学 ${termLabel(courseTerm(course))}`, course.subjectCode);

/** sha256 of a file's bytes, or null when it does not exist. */
export async function fileHash(path) {
  try { return sha256Hex(await readFile(path)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Captures the course's newest valid earlier Desktop document as an artifact and returns its hash (null when there is
 * none). Called once per course per lineage, when the root job is created (decision #354); resumed jobs copy the hash.
 */
export async function captureEarlierDocument(store, desktopDir, course) {
  const document = await newestCourseDocument(courseFolder(desktopDir, course), course.id);
  return document ? store.putArtifact(JSON.stringify(document)) : null;
}
export function capturedDocument(store, hash) {
  if (!hash) return null;
  const content = store.getArtifact(hash);
  if (content === null) throw new Error('CAPTURED_DOCUMENT_MISSING');
  return JSON.parse(content);
}

/** Whether a collected source entry `{ file, sha256 }` still verifies (the file exists with that sha256). */
export async function verifySource(entry) {
  if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') return false;
  return (await fileHash(entry.file)) === entry.sha256;
}

/**
 * Verified sources from collect rows of the lineage with this input hash, whatever their status (a stopped collect
 * keeps the sources it finished), nearest job first: `{ canvas?: { entry, jobId }, ... }`.
 */
export async function reusableSources(store, jobId, courseId, inputHash) {
  const found = {};
  const rows = store.lineageStages(jobId, courseId, 'collect').filter(row => row.jobId !== jobId && row.inputHash === inputHash);
  for (const source of SOURCES) {
    for (const row of rows) {
      const entry = row.checkpoint?.sources?.[source];
      if (await verifySource(entry)) { found[source] = { entry: { file: entry.file, sha256: entry.sha256, exitCode: entry.exitCode }, jobId: row.jobId }; break; }
    }
  }
  return found;
}

/** A succeeded checkpoint of the lineage with this input hash whose stored output still exists, or null. */
export function reusableCheckpoint(store, jobId, courseId, stage, inputHash) {
  const row = store.findCheckpoint(jobId, courseId, stage, inputHash);
  if (!row || row.jobId === jobId || !row.outputHash) return null;
  const content = store.getArtifact(row.outputHash);
  return content === null ? null : { row, artifact: JSON.parse(content) };
}

export async function readCollected(sources) {
  const entries = await Promise.all(SOURCES.map(async source => [source, JSON.parse(await readFile(sources[source].file, 'utf8'))]));
  return Object.fromEntries(entries);
}

/** Collection flags for `settleCourse`, derived from the collect checkpoint and the collected data. */
export function collectionFlags(sources, data) {
  return {
    canvasFailed: sources.canvas.exitCode !== 0, canvasUnpaginated: data.canvas?.paginationVerified === false,
    edFailed: sources.ed.exitCode !== 0, edPartial: data.ed?.status === 'partial', handbookFailed: sources.handbook.exitCode !== 0,
  };
}

/**
 * Merge decision from the lineage's merge rows (newest first, any status, each with `checkpoint.plannedPath`): the
 * first row whose planned file exists decides — its recorded content hash means that write happened (`complete`),
 * other content is a conflict; otherwise the newest row with the same input hash gives the path to write; otherwise a
 * new path is chosen.
 */
export async function planMerge(rows, inputHash) {
  const planned = rows.filter(row => typeof row.checkpoint?.plannedPath === 'string');
  for (const row of planned) {
    const hash = await fileHash(row.checkpoint.plannedPath);
    if (hash !== null) return hash === row.checkpoint.contentHash ? { kind: 'complete', row } : { kind: 'conflict', row };
  }
  const same = planned.find(row => row.inputHash === inputHash);
  return same ? { kind: 'write', path: same.checkpoint.plannedPath } : { kind: 'new' };
}

/** `分数结构.json` when absent, otherwise `分数结构-<jobId>.json`, as before the staged pipeline. */
export async function chooseCoursePath(courseDir, jobId) {
  const path = join(courseDir, '分数结构.json');
  try { await stat(path); return join(courseDir, `分数结构-${jobId}.json`); }
  catch (error) { if (error.code === 'ENOENT') return path; throw error; }
}

/** A stage failure with a code and the course reason shown to the owner. */
export class StageError extends Error {
  constructor(code, reason, extra = {}) {
    super(reason);
    this.name = 'StageError';
    this.code = code;
    this.reason = reason;
    Object.assign(this, extra);
  }
}

/** Thrown out of a stage that did not succeed; `status` is the stage row's final status. */
export class StageFailure extends Error {
  constructor({ stage, status, code, reason, usage = null, phases = {} }) {
    super(reason || code);
    this.name = 'StageFailure';
    Object.assign(this, { stage, status, code, reason, usage, phases });
  }
}

/**
 * Runs one stage of one course: hooks, reuse of a lineage checkpoint, or the work with a `running` row first and a
 * `succeeded` row with checkpoint, output, usage and timing last. A failure records the row as failed, cancelled or
 * interrupted and throws a StageFailure; nothing is written once the pipeline has halted.
 */
async function runStage(ctx, courseId, stage, inputHash, { reuse, work }) {
  const { store, jobId } = ctx;
  await ctx.hook('beforeStage', stage, courseId);
  ctx.assertAlive();
  if (ctx.stopStatus()) throw new StageFailure({ stage, status: ctx.stopStatus(), code: ctx.stopStatus().toUpperCase(), reason: '' });
  const reused = reuse ? await reuse() : null;
  ctx.assertAlive();
  if (reused) {
    const at = ctx.isoNow();
    store.saveStage({ jobId, courseId, stage, inputHash, status: 'succeeded', checkpoint: reused.checkpoint, outputHash: reused.outputHash ?? null,
      reusedFrom: reused.from, attempts: 0, usage: null, startedAt: at, finishedAt: at, durationMs: 0 });
    await ctx.hook('afterCheckpoint', stage, courseId);
    return { ...reused.result, reused: true };
  }
  const startedAt = ctx.isoNow(), started = ctx.now();
  store.saveStage({ jobId, courseId, stage, inputHash, status: 'running', startedAt });
  let out;
  try {
    out = await work();
  } catch (error) {
    if (ctx.halted()) throw error;
    const failure = toFailure(ctx, stage, error);
    try {
      store.updateStage(jobId, courseId, stage, { status: failure.status, errorCode: failure.code, error: String(error?.message ?? error).slice(0, 500),
        finishedAt: ctx.isoNow(), durationMs: ctx.now() - started, attempts: error?.attempts ?? 0, usage: failure.usage });
    } catch { /* The failure is reported through the course row. */ }
    throw failure;
  }
  store.saveStage({ jobId, courseId, stage, inputHash, status: 'succeeded', checkpoint: out.checkpoint, outputHash: out.outputHash ?? null,
    attempts: out.attempts ?? 1, usage: out.usage ?? null, startedAt, finishedAt: ctx.isoNow(), durationMs: ctx.now() - started });
  await ctx.hook('afterCheckpoint', stage, courseId);
  return out.result;
}

function toFailure(ctx, stage, error) {
  const extra = { usage: error?.usage ?? null, phases: error?.phases ?? {} };
  if (ctx.stopStatus() || error?.name === 'AbortError') {
    const status = ctx.stopStatus() ?? 'cancelled';
    return new StageFailure({ stage, status, code: status.toUpperCase(), reason: '', ...extra });
  }
  if (error instanceof StageError) return new StageFailure({ stage, status: 'failed', code: error.code, reason: error.reason, ...extra });
  return new StageFailure({ stage, status: 'failed', code: 'UNEXPECTED', reason: stage === 'collect' ? REASONS.collectUnexpected : REASONS.stageUnexpected, ...extra });
}

/** Collector script and arguments for a source (unchanged from the sequential runner); null when it cannot run. */
export function collectorCommand(course, source, file) {
  const term = courseTerm(course);
  if (source === 'canvas') return { script: 'canvas-background.mjs', args: [course.id, file] };
  if (source === 'ed') return { script: 'collect-ed-course.mjs', args: [course.subjectCode, term, file] };
  const year = /\b(20\d{2})\b/.exec(term)?.[1];
  return year ? { script: 'collect-handbook.mjs', args: [course.subjectCode, year, file] } : null;
}

/** Real collector: a detached child process, stopped through `registerStop` (SIGTERM, SIGKILL after 5 s) or after 120 s. */
export function spawnCollector({ script, args, cwd, registerStop }) {
  return new Promise(resolveTask => {
    const proc = spawn(process.execPath, [join(cwd, 'scripts', script), ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '', done = false, escalation;
    proc.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString().slice(0, 4000 - stderr.length); });
    const stop = () => {
      try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' }); else if (proc.pid) process.kill(-proc.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      if (!escalation) escalation = setTimeout(() => { try { if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 5000);
    };
    const untrack = registerStop(stop);
    const timer = setTimeout(stop, 120000);
    const finish = code => { if (done) return; done = true; clearTimeout(timer); untrack(); resolveTask({ code, error: stderr.trim().slice(0, 500) }); };
    proc.on('error', () => finish(null));
    proc.on('close', finish);
  });
}

/**
 * Collect: the three collectors in order into the job's run directory, through the platform limiters. Verified
 * sources of the lineage are reused one by one; the checkpoint is updated after each source. A failed collector gives
 * the `unavailable` placeholder as before; a temporary failure left after retries (exit 75) fails the stage so the
 * source is collected again on resume.
 */
export async function collectStage(ctx, course) {
  const inputHash = collectInputHash({ courseId: course.id, code: course.subjectCode, term: courseTerm(course) });
  const runDir = join(ctx.projectDir, '.local', 'lms', 'runs', ctx.jobId, course.id);
  let found = {};
  return runStage(ctx, course.id, 'collect', inputHash, {
    async reuse() {
      found = await reusableSources(ctx.store, ctx.jobId, course.id, inputHash);
      if (!SOURCES.every(source => found[source])) return null;
      const from = ctx.lineageIds.find(id => SOURCES.some(source => found[source].jobId === id));
      const sources = Object.fromEntries(SOURCES.map(source => [source, { ...found[source].entry, reusedFrom: found[source].jobId }]));
      return { from, checkpoint: { sources }, result: { sources, phases: {}, reusedSources: [...SOURCES] } };
    },
    async work() {
      const sources = {}, phases = {}, budget = { waitedMs: 0 };
      let attempts = 0;
      for (const source of SOURCES) {
        if (found[source]) { sources[source] = { ...found[source].entry, reusedFrom: found[source].jobId }; continue; }
        ctx.setCourse(course.id, { phase: source });
        const started = ctx.now();
        const file = join(runDir, `${source}.json`);
        await ctx.io.mkdir(runDir, { recursive: true, mode: 0o700 });
        const command = collectorCommand(course, source, file);
        let code = null;
        if (command) {
          const outcome = await ctx.limiters.collect(source).run(async () => {
            ctx.assertAlive();
            attempts++;
            const result = await ctx.runCollector({ source, ...command, cwd: ctx.projectDir, registerStop: ctx.registerStop, signal: ctx.signal });
            if (result.code === 0) return { ok: true, value: result };
            return { ok: false, retryable: result.code === EX_TEMPFAIL && !ctx.stopStatus(), error: result.error, code: result.code };
          }, { signal: ctx.signal, budget });
          phases[`${source}Ms`] = ctx.now() - started;
          if (ctx.stopStatus()) throw Object.assign(new Error('stopped'), { phases, attempts });
          code = outcome.ok ? 0 : outcome.code;
          if (code === EX_TEMPFAIL) {
            throw new StageError('COLLECT_TEMPORARY', `${SOURCE_LABELS[source]} 暂时无法访问（限流或服务器错误，已重试 ${outcome.attempts} 次），可以继续上次同步。`, { phases, attempts });
          }
        } else phases[`${source}Ms`] = ctx.now() - started;
        if (code !== 0) await ctx.io.writeFile(file, PLACEHOLDERS[source], { mode: 0o600 });
        sources[source] = { file, sha256: await fileHash(file), exitCode: code };
        if (sources[source].sha256 === null) throw new Error('COLLECTED_FILE_MISSING');
        ctx.store.updateStage(ctx.jobId, course.id, 'collect', { checkpoint: { sources } });
      }
      return { checkpoint: { sources }, attempts, result: { sources, phases, reusedSources: SOURCES.filter(source => found[source]) } };
    },
  });
}

const addUsage = (a, b) => {
  if (!a || !b) return a ?? b ?? null;
  return Object.fromEntries(['input', 'cached', 'output', 'reasoning'].map(key => [key, Number.isSafeInteger(a[key]) && Number.isSafeInteger(b[key]) ? a[key] + b[key] : (a[key] ?? null)]));
};

/**
 * Analyse: the prompt from the collected data, then the model with the existing repair loop, each call through the
 * provider's limiter (retries for HTTP 429/5xx and connection errors). The whole stage is atomic. A final call that
 * ended with a non-zero exit fails the stage with the provider's error as the reason; an invalid reply after repair is
 * a succeeded stage whose result validate turns into a failed course.
 */
export async function analyseStage(ctx, course, collected) {
  const data = await readCollected(collected.sources);
  const prompt = buildAnalysisPrompt({ course, term: courseTerm(course), ...data });
  const inputHash = analyseInputHash({ prompt, config: ctx.config });
  return runStage(ctx, course.id, 'analyse', inputHash, {
    reuse() {
      const found = reusableCheckpoint(ctx.store, ctx.jobId, course.id, 'analyse', inputHash);
      return found && { from: found.row.jobId, checkpoint: found.row.checkpoint, outputHash: found.row.outputHash,
        result: { artifactHash: found.row.outputHash, artifact: found.artifact, usage: null, durationMs: 0 } };
    },
    async work() {
      ctx.setCourse(course.id, { phase: 'analysis' });
      const started = ctx.now(), startedDate = new Date(ctx.now());
      const budget = { waitedMs: 0 };
      let calls = 0, retried = null;
      const logical = [], every = [];
      const run = async text => {
        const results = [];
        const outcome = await ctx.limiters.model(ctx.config.provider).run(async () => {
          ctx.assertAlive();
          calls++;
          const result = await ctx.callModel(ctx.config, text, { schema: ctx.schema, schemaPath: ctx.schemaPath, cwd: ctx.projectDir,
            registerStop: ctx.registerStop, onPhase: () => ctx.setCourse(course.id, { phase: 'analysis' }) });
          results.push(result);
          every.push(result);
          if (result.exitCode === 0) return { ok: true, value: result };
          return { ok: false, retryable: isTemporaryFailure(result) && !ctx.stopStatus(), retryAfterMs: result.retryAfterMs ?? null, error: result.error, value: result };
        }, { signal: ctx.signal, budget });
        // Usage reported by failed calls that were retried counts too (design §9).
        for (const failed of results.slice(0, -1)) retried = addUsage(retried, failed.usage);
        logical.push(outcome.value);
        return outcome.value;
      };
      let analysis;
      try {
        analysis = await analyseWithRepair({ instructions: prompt, run, validate: raw => validateAnalysis(raw, { course, ...data }), isCancelled: () => Boolean(ctx.stopStatus()) });
      } catch (error) {
        // Stopped while waiting for a slot or a retry: count every call that already returned.
        const spent = every.reduce((sum, item) => addUsage(sum, item.usage), null);
        throw Object.assign(error, { attempts: calls, usage: spent ? { coordinator: spent, subagents: null } : null });
      }
      const { result, attempts } = analysis;
      const coordinator = addUsage(result.usage, retried);
      if (attempts.length > 1) await ctx.writeDiagnostic(`${ctx.jobId}-${course.id}-attempts.json`, attempts);
      if (ctx.stopStatus()) throw Object.assign(new Error('stopped'), { attempts: calls, usage: { coordinator, subagents: null } });
      const subagents = await ctx.childUsage(result.threadId, startedDate);
      const usage = { coordinator, subagents };
      if (result.exitCode !== 0) {
        await ctx.writeDiagnostic(`${ctx.jobId}-${course.id}.json`, { raw: result.lastMessage, issues: result.issues ?? [] });
        throw new StageError('MODEL_FAILED', result.error || REASONS.modelFailed, { attempts: calls, usage });
      }
      const artifact = {
        attempts: attempts.map((attempt, index) => ({ ...attempt, httpStatus: logical[index]?.httpStatus ?? null })),
        final: { exitCode: result.exitCode, lastMessage: result.lastMessage, error: result.error ?? null, threadId: result.threadId ?? null },
        usage: coordinator,
      };
      const hash = ctx.store.putArtifact(JSON.stringify(artifact));
      return { checkpoint: { artifact: hash }, outputHash: hash, usage, attempts: calls,
        result: { artifactHash: hash, artifact, usage, durationMs: ctx.now() - started } };
    },
  });
}

/**
 * Validate: `validateAnalysis` on the final reply, then `settleCourse` (quote verification included) with the
 * collection flags and the captured earlier document. Writes the diagnostic file as before.
 */
export async function validateStage(ctx, course, collected, analysed, previousHash) {
  const inputHash = validateInputHash({ analyseArtifact: analysed.artifactHash, sources: collected.sources, previous: previousHash });
  return runStage(ctx, course.id, 'validate', inputHash, {
    reuse() {
      const found = reusableCheckpoint(ctx.store, ctx.jobId, course.id, 'validate', inputHash);
      return found && { from: found.row.jobId, checkpoint: found.row.checkpoint, outputHash: found.row.outputHash, result: { artifactHash: found.row.outputHash, artifact: found.artifact } };
    },
    async work() {
      ctx.setCourse(course.id, { phase: 'saving' });
      const data = await readCollected(collected.sources);
      const previous = capturedDocument(ctx.store, previousHash);
      const { final, usage } = analysed.artifact;
      const validation = validateAnalysis(final.lastMessage, { course, ...data });
      const result = { exitCode: final.exitCode, lastMessage: final.lastMessage, usage, error: final.error ?? undefined, threadId: final.threadId, issues: validation.issues };
      const settled = settleCourse({ result, validation, collection: collectionFlags(collected.sources, data), data, previous });
      if (settled.diagnostic) await ctx.writeDiagnostic(`${ctx.jobId}-${course.id}.json`, settled.diagnostic);
      const artifact = { accepted: settled.accepted, status: settled.status, reason: settled.reason, document: settled.document, diagnostic: settled.diagnostic, previous: previousHash ?? null };
      const hash = ctx.store.putArtifact(JSON.stringify(artifact));
      return { checkpoint: { artifact: hash }, outputHash: hash, result: { artifactHash: hash, artifact } };
    },
  });
}

/**
 * Merge (write-ahead, decision #353): consult every merge row of the lineage for this course; complete from a row
 * whose file was written, write to a planned path whose file is missing, or fail `MERGE_TARGET_CHANGED`; otherwise
 * record `{ plannedPath, contentHash }` before writing with exclusive create. Then the snapshot and the change log
 * (skipped when a line of this course from any lineage job exists). A result without a document only records it.
 */
export async function mergeStage(ctx, course, validated, previousHash) {
  const courseDir = courseFolder(ctx.desktopDir, course);
  const inputHash = mergeInputHash({ validateArtifact: validated.artifactHash, courseDir });
  return runStage(ctx, course.id, 'merge', inputHash, {
    async work() {
      ctx.setCourse(course.id, { phase: 'saving' });
      const outcome = validated.artifact;
      if (!outcome.document) {
        return { checkpoint: { plannedPath: null, contentHash: null, validateArtifact: validated.artifactHash, changeLog: false, status: outcome.status, reason: outcome.reason },
          result: { status: outcome.status, reason: outcome.reason, file: null } };
      }
      const rows = ctx.store.lineageStages(ctx.jobId, course.id, 'merge').filter(row => row.jobId !== ctx.jobId);
      const plan = await planMerge(rows, inputHash);
      if (plan.kind === 'conflict') throw new StageError('MERGE_TARGET_CHANGED', REASONS.mergeTargetChanged);
      let final, path;
      if (plan.kind === 'complete') {
        // That write happened before the crash: the owner already has this file, so its document is the result.
        const checkpoint = plan.row.checkpoint;
        const earlier = JSON.parse(ctx.store.getArtifact(checkpoint.validateArtifact));
        path = checkpoint.plannedPath;
        final = { status: earlier.status, reason: earlier.reason, document: earlier.document, content: await readFile(path, 'utf8'),
          contentHash: checkpoint.contentHash, validateArtifact: checkpoint.validateArtifact };
        ctx.store.updateStage(ctx.jobId, course.id, 'merge', { checkpoint: { plannedPath: path, contentHash: final.contentHash, validateArtifact: final.validateArtifact, changeLog: false, completedFrom: plan.row.jobId } });
      } else {
        const content = `${JSON.stringify(outcome.document, null, 2)}\n`;
        final = { status: outcome.status, reason: outcome.reason, document: outcome.document, content, contentHash: sha256Hex(content), validateArtifact: validated.artifactHash };
        await ctx.io.mkdir(courseDir, { recursive: true });
        path = plan.kind === 'write' ? plan.path : await chooseCoursePath(courseDir, ctx.jobId);
        ctx.store.updateStage(ctx.jobId, course.id, 'merge', { checkpoint: { plannedPath: path, contentHash: final.contentHash, validateArtifact: final.validateArtifact, changeLog: false } });
        try {
          await ctx.io.writeFile(path, content, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if ((await fileHash(path)) !== final.contentHash) throw new StageError('MERGE_TARGET_CHANGED', REASONS.mergeTargetChanged);
        }
        await ctx.hook('afterMergeWrite', course.id);
      }
      ctx.store.putSnapshot({ jobId: ctx.jobId, courseId: course.id, document: final.content, version: final.document.version ?? null, status: final.status, reason: final.reason, file: path });
      // Change log (decision #355): only with an earlier document, at most once per course per lineage. A log that
      // cannot be read or written adds 「变更记录写入失败。」 to the reason and never changes the status, as before.
      const holder = { reason: final.reason };
      const previous = capturedDocument(ctx.store, previousHash);
      if (previous) {
        let logged;
        try { logged = await changeLogHasRun(ctx.projectDir, course.id, ctx.lineageIds); } catch { logged = null; }
        if (logged === null) holder.reason = [holder.reason, '变更记录写入失败。'].filter(Boolean).join(' ');
        else if (!logged) await ctx.io.recordCourseChanges({ at: ctx.isoNow(), runId: ctx.jobId, courseId: course.id, previous, current: final.document }, holder);
      }
      return { checkpoint: { plannedPath: path, contentHash: final.contentHash, validateArtifact: final.validateArtifact, changeLog: true,
        status: final.status, reason: holder.reason, ...(plan.kind === 'complete' ? { completedFrom: plan.row.jobId } : {}) },
      result: { status: final.status, reason: holder.reason, file: path } };
    },
  });
}
