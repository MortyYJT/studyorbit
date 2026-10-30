import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { manualClock } from '../scripts/lib/rate-limit.mjs';
import { createSyncLimiters, createSyncPipeline, RESUME_WINDOW_MS, type SyncPipeline } from '../scripts/lib/sync-pipeline.mjs';
import type { SyncStore } from '../scripts/lib/sync-store.mjs';
import {
  changeLogLines, courseDir, createProject, desktopFiles, fakeCollectors, fakeConfig, fakeModel, openStore, pipelineFor, START,
  syntheticCourse, usageLines, writeCourseList, writeEarlierDocument, type Project, type SyntheticCourse,
} from './sync-fakes.ts';

// The staged sync pipeline with fake collectors and a fake model (specs/staged-course-sync, design §6-§10). Every test
// runs in a temporary project and Desktop; nothing touches real collectors, a real model or the owner's files.
let project: Project | undefined;
const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* Closed by the test. */ } }
  await project?.cleanup();
  project = undefined;
});

async function setup(count: number, { earlier = [] as number[] } = {}) {
  const courses = Array.from({ length: count }, (_, index) => syntheticCourse(index + 1));
  project = await createProject(courses);
  for (const n of earlier) await writeEarlierDocument(project.desktopDir, courses[n - 1]!);
  return courses;
}
async function store(clock: () => number = () => START) {
  const opened = await openStore(project!.projectDir, clock);
  stores.push(opened);
  return opened;
}
const ids = (courses: SyntheticCourse[]) => courses.map(course => course.id);
async function run(pipeline: SyncPipeline, start: () => Promise<unknown>) {
  await start();
  await pipeline.idle();
  return pipeline.status();
}

/** A pipeline whose model settings resolve only after `gate`, to act while a start is being prepared. */
function createPipelineWithGate(db: SyncStore, collectors: ReturnType<typeof fakeCollectors>, courses: SyntheticCourse[], gate: Promise<void>) {
  const clock = manualClock(START, { instant: true });
  return createSyncPipeline({
    store: db, projectDir: project!.projectDir, desktopDir: project!.desktopDir, runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel,
    resolveModel: async () => { await gate; return fakeConfig; }, childUsage: async () => null, clock, limiters: createSyncLimiters({ clock }), newId: () => 'run-1',
  });
}

describe('a sync through the four stages', () => {
  it('saves the same files, statuses, reasons and usage lines as the sequential runner', async () => {
    const courses = await setup(4, { earlier: [2] });
    const collectors = fakeCollectors(courses, { '900004:ed': { partial: true } });
    const model = fakeModel(courses, { SYNT30003: [{ invalid: true }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));

    expect(status).toMatchObject({ running: false, jobId: 'run-1', resumable: false, error: null });
    expect(status.courses.map(course => [course.code, course.status, course.reason, course.stage, course.reused])).toEqual([
      ['SYNT10001', 'completed', '', 'merge', false],
      ['SYNT20002', 'completed', '', 'merge', false],
      ['SYNT30003', 'completed', '', 'merge', false],
      ['SYNT40004', 'partial', '部分 Ed 数据未能读取；', 'merge', false],
    ]);
    // Course files: 分数结构.json, or 分数结构-<runId>.json beside an earlier file; owner-only.
    const files = await desktopFiles(project!.desktopDir);
    expect(Object.keys(files).sort()).toEqual([
      '墨尔本大学 2026 S2/SYNT10001/分数结构.json', '墨尔本大学 2026 S2/SYNT20002/分数结构-<run>.json', '墨尔本大学 2026 S2/SYNT20002/分数结构.json',
      '墨尔本大学 2026 S2/SYNT30003/分数结构.json', '墨尔本大学 2026 S2/SYNT40004/分数结构.json',
    ]);
    expect(status.courses[1]!.file).toBe(join(courseDir(project!.desktopDir, courses[1]!), '分数结构-run-1.json'));
    expect((await stat(status.courses[0]!.file!)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(files['墨尔本大学 2026 S2/SYNT20002/分数结构-<run>.json']!);
    expect(saved).toMatchObject({ version: 2, course: { id: '900002', code: 'SYNT20002' } });
    expect(saved.legacyIds).toMatchObject({ 7001: 'canvas:7001' });
    // The change log line comes from the captured earlier document (weight 25 → 30).
    expect(await changeLogLines(project!.projectDir)).toEqual([expect.objectContaining({ runId: 'run-1', courseId: '900002', assessmentId: 'canvas:7001', field: 'weight', before: 25, after: 30 })]);
    // Collection stays serial; Canvas and the Handbook never overlap.
    expect(collectors.calls).toHaveLength(12);
    expect(collectors.overlaps).toEqual([]);
    expect(model.count()).toBe(5);
    // The repaired course keeps its attempts as a diagnostic, as before.
    expect(await readdir(join(project!.projectDir, '.local', 'lms', 'sync-errors'))).toEqual(['run-1-900003-attempts.json']);

    const usage = await usageLines(project!.projectDir);
    expect(usage[0]).toMatchObject({ type: 'batch_start', runId: 'run-1', courses: ['SYNT10001', 'SYNT20002', 'SYNT30003', 'SYNT40004'] });
    expect(usage.at(-1)).toMatchObject({ type: 'batch_end', runId: 'run-1', courses: status.courses.map(({ code, status }) => ({ code, status })) });
    const lines = usage.slice(1, -1);
    expect(lines.map(line => line.course).sort()).toEqual(['SYNT10001', 'SYNT20002', 'SYNT30003', 'SYNT40004']);
    for (const line of lines) {
      expect(line).toMatchObject({ runId: 'run-1', model: 'fake-model', status: expect.any(String), coordinator: { input: expect.any(Number), output: expect.any(Number) }, subagents: null });
      expect(line.phases).toMatchObject({ canvasMs: expect.any(Number), edMs: expect.any(Number), handbookMs: expect.any(Number), analysisMs: expect.any(Number) });
      expect(line).not.toHaveProperty('reused');
    }
    const repaired = lines.find(line => line.course === 'SYNT30003')!;
    expect(repaired.coordinator.input).toBeGreaterThan(lines.find(line => line.course === 'SYNT10001')!.coordinator.input);

    // Checkpoints: four succeeded stages per course; collect lists the files with their sha256; analyse has usage.
    for (const course of courses) {
      for (const stage of ['collect', 'analyse', 'validate', 'merge'] as const) expect(db.getStage('run-1', course.id, stage)).toMatchObject({ status: 'succeeded', reusedFrom: null });
      const collect = db.getStage('run-1', course.id, 'collect')!;
      expect(Object.keys((collect.checkpoint as { sources: object }).sources)).toEqual(['canvas', 'ed', 'handbook']);
      expect(db.getStage('run-1', course.id, 'analyse')!.usage).toMatchObject({ coordinator: { input: expect.any(Number) } });
      expect(db.getSnapshot('run-1', course.id)).toMatchObject({ version: 2 });
    }
    expect(db.getJob('run-1')).toMatchObject({ status: 'finished', provider: 'deepseek', model: 'fake-model', finishedAt: expect.any(String) });
  });

  it('writes the Ed placeholder when the Ed collector exits with 1; collect succeeds and the course is at most partial', async () => {
    const courses = await setup(1);
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses, { '900001:ed': { exit: [1] } }).runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    const collect = db.getStage('run-1', '900001', 'collect')!;
    expect(collect).toMatchObject({ status: 'succeeded', checkpoint: { sources: { ed: { exitCode: 1 } } } });
    const ed = (collect.checkpoint as { sources: { ed: { file: string } } }).sources.ed.file;
    // The placeholder carries the cause taken from the collector's stderr (decision #481).
    expect(await readFile(ed, 'utf8')).toBe(JSON.stringify({ status: 'unavailable', lessons: [], scores: [], reason: 'Ed 采集失败：synthetic exit 1' }));
    // The synthetic model output cites Ed lessons that were not collected, so validation rejects it.
    expect(['partial', 'failed']).toContain(status.courses[0]!.status);
  });

  it('records a still-invalid reply as succeeded analyse and validate with a failed course and no file', async () => {
    const courses = await setup(1);
    const model = fakeModel(courses, { SYNT10001: [{ invalid: true }, { invalid: true }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^课程数据校验失败：/) });
    expect(status.courses[0]).not.toHaveProperty('file');
    expect(db.getStage('run-1', '900001', 'analyse')!.status).toBe('succeeded');
    expect(db.getStage('run-1', '900001', 'validate')!.status).toBe('succeeded');
    expect(db.getStage('run-1', '900001', 'merge')).toMatchObject({ status: 'succeeded', checkpoint: { plannedPath: null } });
    expect(db.getJob('run-1')!.status).toBe('finished');
    expect(await desktopFiles(project!.desktopDir)).toEqual({});
    expect(await readdir(join(project!.projectDir, '.local', 'lms', 'sync-errors'))).toEqual(['run-1-900001-attempts.json', 'run-1-900001.json']);
  });

  it('fails only the throttled course when the model answers HTTP 429 three times; the job is failed and resumable', async () => {
    const courses = await setup(3);
    const model = fakeModel(courses, { SYNT20002: [{ status: 429, retryAfterMs: 1000 }, { status: 429 }, { status: 429 }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses.map(course => course.status)).toEqual(['completed', 'failed', 'completed']);
    expect(status.courses[1]).toMatchObject({ reason: 'DeepSeek 接口返回 HTTP 429。', stage: 'analyse' });
    expect(db.getJob('run-1')!.courses[1]).toMatchObject({ stoppedStage: 'analyse' });
    expect(db.getStage('run-1', '900002', 'analyse')).toMatchObject({ status: 'failed', errorCode: 'MODEL_FAILED', attempts: 3 });
    expect(model.count('900002')).toBe(3);
    expect(status).toMatchObject({ running: false, resumable: true });
    expect(db.getJob('run-1')!.status).toBe('failed');
  });

  it('does not retry HTTP 401 and fails analyse with the provider error', async () => {
    const courses = await setup(1);
    const model = fakeModel(courses, { SYNT10001: [{ status: 401 }] });
    const pipeline = pipelineFor(project!, await store(), { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(model.count()).toBe(1);
    expect(status.courses[0]).toMatchObject({ status: 'failed', reason: 'DeepSeek 接口返回 HTTP 401。', stage: 'analyse' });
  });

  it('retries a temporary collector failure (exit 75) and fails collect when it persists, keeping other courses', async () => {
    const courses = await setup(2);
    const collectors = fakeCollectors(courses, { '900001:canvas': { exit: [75, 0] }, '900002:ed': { exit: [75, 75, 75] } });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'completed', reason: '' });
    expect(status.courses[1]).toMatchObject({ status: 'failed', stage: 'collect', reason: 'Ed 暂时无法访问（限流或服务器错误，已重试 3 次），可以继续上次同步。' });
    expect(collectors.count(key => key === '900001:canvas')).toBe(2);
    expect(collectors.count(key => key.startsWith('900002:'))).toBe(4); // Canvas once, Ed three times, no Handbook.
    // The finished source stays in the stopped checkpoint for resume.
    expect(db.getStage('run-1', '900002', 'collect')).toMatchObject({ status: 'failed', errorCode: 'COLLECT_TEMPORARY', checkpoint: { sources: { canvas: { exitCode: 0 } } } });
    expect(db.getJob('run-1')!.status).toBe('failed');
  });

  it('fails collect without retry when the dedicated browser is signed out (exit 77), and a resume collects that source again', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses, { '900001:canvas': { exit: [77, 0] } });
    const db = await store();
    const deps = { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel };
    const pipeline = pipelineFor(project!, db, deps, { ids: ['run-1', 'run-2'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'failed', stage: 'collect', reason: 'Canvas：请在专用浏览器里登录后继续同步。' });
    expect(collectors.count(key => key === '900001:canvas')).toBe(1);
    expect(collectors.count(key => key !== '900001:canvas')).toBe(0);
    // No placeholder is kept for the signed-out source.
    expect(db.getStage('run-1', '900001', 'collect')).toMatchObject({ status: 'failed', errorCode: 'COLLECT_SIGN_IN' });
    expect((db.getStage('run-1', '900001', 'collect')!.checkpoint as { sources?: object } | null)?.sources ?? {}).toEqual({});
    expect(status).toMatchObject({ resumable: true });
    const resumed = await run(pipeline, () => pipeline.resume('run-1'));
    expect(resumed.courses[0]).toMatchObject({ status: 'completed' });
    expect(collectors.count(key => key === '900001:canvas')).toBe(2);
  });

  it('runs at most four model calls at a time', async () => {
    const courses = await setup(6);
    const scripts = Object.fromEntries(courses.map(course => [course.code, [{ hang: true }]]));
    const model = fakeModel(courses, scripts);
    const pipeline = pipelineFor(project!, await store(), { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel });
    await pipeline.start(ids(courses));
    await expect.poll(() => model.count(), { interval: 5 }).toBe(4);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(model.peak()).toBe(4);
    pipeline.cancel();
    await pipeline.idle();
    expect(model.count()).toBe(4);
  });

  it('refuses a second start while one runs', async () => {
    const courses = await setup(1);
    const model = fakeModel(courses, { SYNT10001: [{ hang: true }] });
    const pipeline = pipelineFor(project!, await store(), { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel });
    await pipeline.start(ids(courses));
    await expect(pipeline.start(ids(courses))).rejects.toThrow('SYNC_RUNNING');
    pipeline.cancel();
    await pipeline.idle();
  });

  it('refuses an invalid selection and a missing model configuration without creating a job', async () => {
    const courses = await setup(1);
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel });
    for (const selection of [[], ['900009'], ['900001', '900001'], ['x']]) await expect(pipeline.start(selection)).rejects.toThrow('INVALID_SELECTION');
    const unconfigured = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel },
      { config: { provider: 'deepseek', model: 'fake-model', baseUrl: null, apiKey: null } });
    await expect(unconfigured.start(['900001'])).rejects.toThrow('ANALYSIS_KEY_MISSING');
    expect(db.listJobs()).toEqual([]);
    expect(pipeline.status()).toEqual({ running: false, courses: [], error: null, jobId: null, resumable: false });
  });

  it('keeps a course saved when the change log cannot be read, adding 「变更记录写入失败。」 as before', async () => {
    const courses = await setup(2, { earlier: [2] });
    await mkdir(join(project!.projectDir, '.local', 'lms', 'changes.jsonl'));
    const pipeline = pipelineFor(project!, await store(), { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses.map(course => [course.status, course.reason])).toEqual([['completed', ''], ['completed', '变更记录写入失败。']]);
    expect(status.courses.every(course => course.file)).toBe(true);
  });

  it('marks the job and its courses failed when the batch_start line cannot be written', async () => {
    const courses = await setup(1);
    await mkdir(join(project!.projectDir, '.local', 'lms', 'course-sync-usage.jsonl'));
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    await expect(pipeline.start(ids(courses))).rejects.toThrow();
    expect(db.getJob('run-1')).toMatchObject({ status: 'failed', error: '同步记录保存失败。', courses: [{ status: 'failed', reason: '同步记录保存失败。' }] });
    expect(pipeline.running()).toBe(false);
  });

  it('applies a cancel that arrives while the start is being prepared, before any collector runs', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses);
    const db = await store();
    const gate = Promise.withResolvers<void>();
    const pipeline = createPipelineWithGate(db, collectors, courses, gate.promise);
    const starting = pipeline.start(ids(courses));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(pipeline.running()).toBe(true);
    pipeline.cancel();
    gate.resolve();
    await starting;
    await pipeline.idle();
    expect(collectors.calls).toEqual([]);
    expect(db.getJob('run-1')).toMatchObject({ status: 'cancelled', courses: [{ status: 'cancelled' }] });
  });

  it('records the planned path and content hash before writing the course file', async () => {
    const courses = await setup(1);
    let seen: unknown;
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel }, {
      ids: ['run-1'], hooks: { afterMergeWrite: () => { seen = db.getStage('run-1', '900001', 'merge'); } },
    });
    await run(pipeline, () => pipeline.start(ids(courses)));
    const file = join(courseDir(project!.desktopDir, courses[0]!), '分数结构.json');
    expect(seen).toMatchObject({ status: 'running', checkpoint: { plannedPath: file, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), changeLog: false } });
    expect(db.getStage('run-1', '900001', 'merge')).toMatchObject({ status: 'succeeded', checkpoint: { plannedPath: file, changeLog: true } });
  });
});

describe('resume', () => {
  /** A job whose course 2 failed in analyse (HTTP 429 three times); courses 1 and 3 saved. */
  async function failedJob(options: { clock?: ReturnType<typeof manualClock>; throttled?: number } = {}) {
    const courses = await setup(3, { earlier: [2] });
    const collectors = fakeCollectors(courses);
    const model = fakeModel(courses, { SYNT20002: Array.from({ length: options.throttled ?? 3 }, () => ({ status: 429 })) });
    const db = await store(options.clock ? () => options.clock!.now() : () => START);
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1', 'run-2', 'run-3'], clock: options.clock });
    await run(pipeline, () => pipeline.start(ids(courses)));
    return { courses, collectors, model, db, pipeline };
  }

  it('creates a new job from the stopped one, reuses collect, runs analyse, and copies done courses', async () => {
    const { collectors, model, db, pipeline } = await failedJob();
    const calls = { collect: collectors.calls.length, model: model.count() };
    const status = await run(pipeline, () => pipeline.resume('run-1'));
    expect(status).toMatchObject({ jobId: 'run-2', resumedFrom: 'run-1', running: false, resumable: false });
    expect(status.courses.map(course => [course.status, course.reused])).toEqual([['completed', true], ['completed', false], ['completed', true]]);
    expect(collectors.calls.length).toBe(calls.collect);
    expect(model.count() - calls.model).toBe(1);
    expect(db.getStage('run-2', '900002', 'collect')).toMatchObject({ status: 'succeeded', reusedFrom: 'run-1' });
    expect(db.getStage('run-2', '900002', 'analyse')).toMatchObject({ status: 'succeeded', reusedFrom: null });
    expect(db.getStage('run-2', '900001', 'collect')).toBeNull();
    expect(db.getJob('run-2')).toMatchObject({ status: 'finished', resumedFrom: 'run-1' });
    // Copied courses keep their file and status; the previous job stays as it was.
    expect(status.courses[0]!.file).toBe(db.getJob('run-1')!.courses[0]!.file);
    expect(db.getJob('run-1')!.status).toBe('failed');
    // Usage: one line per course of this job, with only this job's usage and the reused stages.
    const usage = (await usageLines(project!.projectDir)).filter(line => line.runId === 'run-2');
    expect(usage[0]).toMatchObject({ type: 'batch_start', resumedFrom: 'run-1' });
    const lines = usage.filter(line => !line.type);
    expect(lines).toHaveLength(3);
    expect(lines.find(line => line.course === 'SYNT10001')).toMatchObject({ coordinator: { input: 0, output: 0 }, reused: ['collect', 'analyse', 'validate', 'merge'] });
    expect(lines.find(line => line.course === 'SYNT20002')).toMatchObject({ reused: ['collect'], coordinator: { input: expect.any(Number) } });
    // The earlier document is the one captured by the first job: same legacy IDs, one change-log line.
    expect(db.getJob('run-2')!.courses[1]!.previous).toBe(db.getJob('run-1')!.courses[1]!.previous);
    expect(await changeLogLines(project!.projectDir)).toEqual([expect.objectContaining({ runId: 'run-2', courseId: '900002' })]);
  });

  it('collects a source again when its file changed and re-runs the later stages', async () => {
    const { collectors, db, pipeline } = await failedJob();
    const sources = (db.getStage('run-1', '900002', 'collect')!.checkpoint as { sources: Record<string, { file: string }> }).sources;
    await writeFile(sources.ed!.file, JSON.stringify({ status: 'unavailable', lessons: [], scores: [], reason: 'edited' }));
    const before = collectors.calls.length;
    await run(pipeline, () => pipeline.resume('run-1'));
    expect(collectors.calls.slice(before)).toEqual(['900002:ed']);
    const collect = db.getStage('run-2', '900002', 'collect')!;
    expect(collect).toMatchObject({ status: 'succeeded', reusedFrom: null });
    expect(collect.checkpoint).toMatchObject({ sources: { canvas: { reusedFrom: 'run-1' }, ed: { file: expect.stringContaining(join('runs', 'run-2', '900002')) }, handbook: { reusedFrom: 'run-1' } } });
  });

  it('reuses the analyse checkpoint with the same model and re-runs analyse with a changed model', async () => {
    for (const [model, calls] of [['fake-model', 0], ['other-fake-model', 1]] as const) {
      const courses = await setup(2);
      const fakes = { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel };
      const db = await store();
      let first: SyncPipeline;
      // Cancelled right after course 2's analyse checkpoint: validate and merge have not run.
      first = pipelineFor(project!, db, fakes, { ids: ['run-1'], hooks: { afterCheckpoint: (stage, courseId) => { if (stage === 'analyse' && courseId === '900002') first.cancel(); } } });
      await run(first, () => first.start(ids(courses)));
      expect(db.getStage('run-1', '900002', 'analyse')!.status).toBe('succeeded');
      expect(db.getJob('run-1')!.status).toBe('cancelled');
      const model2 = fakeModel(courses);
      const second = pipelineFor(project!, db, { runCollector: fakes.runCollector, callModel: model2.callModel }, { ids: ['run-2'], config: { provider: 'deepseek', model, baseUrl: null, apiKey: 'synthetic' } });
      const status = await run(second, () => second.resume('run-1'));
      expect(status.courses.map(course => course.status)).toEqual(['completed', 'completed']);
      expect(model2.count('900002')).toBe(calls);
      expect(db.getStage('run-2', '900002', 'analyse')).toMatchObject({ reusedFrom: calls ? null : 'run-1' });
      expect(db.getStage('run-2', '900001', 'analyse')).toBeNull(); // course 1 was done: copied, not re-analysed
      expect(db.getJob('run-2')).toMatchObject({ model });
      for (const opened of stores.splice(0)) opened.close();
      await project!.cleanup();
    }
    project = undefined;
  });

  it('never reuses checkpoints in a fresh sync', async () => {
    const { collectors, model, pipeline } = await failedJob();
    const before = { collect: collectors.calls.length, model: model.count() };
    await run(pipeline, () => pipeline.start(['900001']));
    expect(collectors.calls.length - before.collect).toBe(3);
    expect(model.count() - before.model).toBe(1);
  });

  it('answers NOT_RESUMABLE, ALREADY_RESUMED, JOB_NOT_FOUND and SYNC_RUNNING', async () => {
    const { pipeline, db } = await failedJob();
    await expect(pipeline.resume('missing')).rejects.toThrow('JOB_NOT_FOUND');
    await run(pipeline, () => pipeline.resume('run-1'));
    await expect(pipeline.resume('run-1')).rejects.toThrow('ALREADY_RESUMED');
    expect(db.getJob('run-2')!.status).toBe('finished');
    await expect(pipeline.resume('run-2')).rejects.toThrow('NOT_RESUMABLE');
    expect(pipeline.jobs().map(job => [job.id, job.status, job.resumable, job.resumedFrom])).toEqual([['run-2', 'finished', false, 'run-1'], ['run-1', 'failed', false, null]]);
    const courses = [syntheticCourse(1)];
    const hanging = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses, { SYNT10001: [{ hang: true }] }).callModel }, { ids: ['run-9'] });
    await hanging.start(['900001']);
    await expect(hanging.resume('run-1')).rejects.toThrow('SYNC_RUNNING');
    hanging.cancel();
    await hanging.idle();
  });

  it('answers RESUME_EXPIRED 24 hours after the lineage root was created', async () => {
    const clock = manualClock(START, { instant: true });
    const { pipeline, db } = await failedJob({ clock });
    clock.advance(Date.parse(db.getJob('run-1')!.createdAt) + RESUME_WINDOW_MS - 1 - clock.now());
    expect(pipeline.status().resumable).toBe(true);
    clock.advance(1);
    expect(pipeline.status().resumable).toBe(false);
    await expect(pipeline.resume('run-1')).rejects.toThrow('RESUME_EXPIRED');
    expect(db.listJobs()).toHaveLength(1);
  });

  it('takes the age from the lineage root for a resume of a resume', async () => {
    const clock = manualClock(START, { instant: true });
    const { pipeline, db } = await failedJob({ clock, throttled: 6 });
    clock.advance(Date.parse(db.getJob('run-1')!.createdAt) + 23 * 60 * 60 * 1000 - clock.now());
    // Course 2 still throttled: the resumed job fails too.
    await run(pipeline, () => pipeline.resume('run-1'));
    expect(db.getJob('run-2')).toMatchObject({ status: 'failed', resumedFrom: 'run-1' });
    clock.advance(2 * 60 * 60 * 1000);
    await expect(pipeline.resume('run-2')).rejects.toThrow('RESUME_EXPIRED');
  });

  it('refuses to resume past the lineage limit, where the results of the root would no longer be visible', async () => {
    const courses = await setup(1);
    const db = await store();
    for (const [prefix, length] of [['a', 20], ['b', 21]] as const) {
      const chain = Array.from({ length }, (_, index) => `${prefix}-${index + 1}`);
      chain.forEach((id, index) => {
        db.createJob({ id, resumedFrom: index ? chain[index - 1] : null, courses: [{ courseId: '900001', code: 'SYNT10001' }] });
        db.updateJob(id, { status: 'failed' });
      });
    }
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: fakeModel(courses).callModel });
    // a-20 heads a lineage of 20 jobs: its resume still sees the root. b-21 heads 21 jobs and cannot be resumed.
    await expect(pipeline.resume('b-21')).rejects.toThrow('NOT_RESUMABLE');
    const status = await run(pipeline, () => pipeline.resume('a-20'));
    expect(status).toMatchObject({ resumedFrom: 'a-20', courses: [{ status: 'completed' }] });
  });

  it('reports courses no longer in the course list as failed', async () => {
    const { pipeline } = await failedJob();
    await writeCourseList(project!.projectDir, [syntheticCourse(1), syntheticCourse(3)]);
    const status = await run(pipeline, () => pipeline.resume('run-1'));
    expect(status.courses.map(course => [course.code, course.status, course.reason])).toEqual([
      ['SYNT10001', 'completed', ''], ['SYNT20002', 'failed', '课程已不在课程列表中'], ['SYNT30003', 'completed', ''],
    ]);
  });
});

describe('cancellation and interruption', () => {
  it('cancels during collect: no further collector call, job cancelled, checkpoints kept, resumable', async () => {
    const courses = await setup(2);
    const collectors = fakeCollectors(courses, { '900001:ed': { hang: true } });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    await pipeline.start(ids(courses));
    await expect.poll(() => collectors.calls.length, { interval: 5 }).toBe(2);
    const cancelled = pipeline.cancel();
    expect(cancelled.courses.map(course => course.status)).toEqual(['cancelled', 'cancelled']);
    await pipeline.idle();
    expect(collectors.calls).toEqual(['900001:canvas', '900001:ed']);
    expect(db.getJob('run-1')).toMatchObject({ status: 'cancelled' });
    expect(db.getStage('run-1', '900001', 'collect')).toMatchObject({ status: 'cancelled', checkpoint: { sources: { canvas: { exitCode: 0 } } } });
    expect(pipeline.status()).toMatchObject({ running: false, resumable: true });
    expect(pipeline.status().courses.map(course => course.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('cancels during a model call: the request is aborted and no further one is sent', async () => {
    const courses = await setup(1);
    const model = fakeModel(courses, { SYNT10001: [{ hang: true }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    await pipeline.start(ids(courses));
    await expect.poll(() => model.count(), { interval: 5 }).toBe(1);
    pipeline.cancel();
    await pipeline.idle();
    expect(model.count()).toBe(1);
    expect(db.getStage('run-1', '900001', 'analyse')).toMatchObject({ status: 'cancelled' });
    expect(db.getJob('run-1')).toMatchObject({ status: 'cancelled', courses: [{ status: 'cancelled' }] });
    expect(pipeline.status().resumable).toBe(true);
    expect((await usageLines(project!.projectDir)).filter(line => !line.type)).toEqual([expect.objectContaining({ status: 'cancelled' })]);
  });

  it('cancels during a backoff wait at once, without another model request', async () => {
    const courses = await setup(1);
    const clock = manualClock(START);
    // The first reply is invalid; the repair call is throttled and the cancel lands during its backoff wait.
    const model = fakeModel(courses, { SYNT10001: [{ invalid: true }, { status: 429, retryAfterMs: 8000 }] });
    const db = await store(() => clock.now());
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel }, { ids: ['run-1'], clock });
    await pipeline.start(ids(courses));
    // Collectors wait 500 ms between starts on this clock; move time until the model's backoff wait is pending.
    for (let step = 0; step < 50 && model.count() < 2; step++) { clock.advance(500); await new Promise(resolve => setTimeout(resolve, 2)); }
    await expect.poll(() => clock.pending(), { interval: 5 }).toBe(1);
    pipeline.cancel();
    await pipeline.idle();
    expect(model.count()).toBe(2);
    // The first call's usage still counts.
    expect((await usageLines(project!.projectDir)).find(line => !line.type)).toMatchObject({ status: 'cancelled', coordinator: { input: expect.any(Number) } });
    expect((await usageLines(project!.projectDir)).find(line => !line.type)!.coordinator.input).toBeGreaterThan(0);
    expect(db.getJob('run-1')!.status).toBe('cancelled');
    expect(db.getStage('run-1', '900001', 'analyse')).toMatchObject({ status: 'cancelled' });
  });

  it('marks the job interrupted on shutdown and keeps it resumable', async () => {
    const courses = await setup(2);
    const model = fakeModel(courses, { SYNT20002: [{ hang: true }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: fakeCollectors(courses).runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    await pipeline.start(ids(courses));
    await expect.poll(() => model.count('900002'), { interval: 5 }).toBe(1);
    await pipeline.shutdown();
    expect(db.getJob('run-1')).toMatchObject({ status: 'interrupted' });
    expect(db.getStage('run-1', '900002', 'analyse')).toMatchObject({ status: 'interrupted' });
    expect(db.getJob('run-1')!.courses.find(course => course.courseId === '900002')).toMatchObject({ status: 'interrupted' });
    expect(pipeline.status().resumable).toBe(true);
    expect(existsSync(join(project!.projectDir, '.local', 'lms', 'course-sync-usage.jsonl'))).toBe(true);
    expect(JSON.parse((await readFile(join(project!.projectDir, '.local', 'lms', 'course-sync-usage.jsonl'), 'utf8')).trim().split('\n').at(-1)!)).toMatchObject({ type: 'batch_end' });
  });
});
