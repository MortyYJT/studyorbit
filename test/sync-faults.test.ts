import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SimulatedCrash, type PipelineHooks } from '../scripts/lib/sync-pipeline.mjs';
import type { StageName, SyncStore } from '../scripts/lib/sync-store.mjs';
import {
  changeLogLines, courseDir, createProject, desktopFiles, fakeCollectors, fakeModel, openStore, pipelineFor, START,
  syntheticCourse, writeEarlierDocument, type Project,
} from './sync-fakes.ts';

// Fault injection at every stage boundary (specs/sync-resume-measurement, design §10, decision #349). Four synthetic
// courses: course 2 has an earlier Desktop document (legacy IDs and a change-log line), course 3 needs the repair call,
// course 4 has partial Ed data. A SimulatedCrash at a boundary of course 2 halts the pipeline instance; the store is
// re-opened (the job becomes `interrupted`) and the job is resumed by a new instance. The result must equal an
// uninterrupted run, with no extra collector or model call. Each boundary also runs "crash + fresh restart" and
// prints fake-model tokens, call counts and wall time per job and both totals (copied into docs/sync-optimization.md).
const courses = [1, 2, 3, 4].map(syntheticCourse);
const ids = courses.map(course => course.id);
const projects: Project[] = [];
const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* Closed by the crash. */ } }
  for (const project of projects.splice(0)) await project.cleanup();
});

async function scenario() {
  const project = await createProject(courses);
  projects.push(project);
  await writeEarlierDocument(project.desktopDir, courses[1]!);
  const collectors = fakeCollectors(courses, { '900004:ed': { partial: true } });
  const model = fakeModel(courses, { SYNT30003: [{ invalid: true }] });
  return { project, collectors, model, fakes: { runCollector: collectors.runCollector, callModel: model.callModel } };
}
async function storeOf(project: Project) {
  const store = await openStore(project.projectDir, () => START);
  stores.push(store);
  return store;
}
const tokens = (usage: { input: number; output: number }) => usage.input + usage.output;

/** Everything compared between runs: Desktop bytes, snapshot hashes, statuses and reasons, change log without run IDs. */
async function outcome(project: Project, store: SyncStore, jobId: string) {
  const job = store.getJob(jobId)!;
  const lineage = store.lineage(jobId);
  const snapshots = Object.fromEntries(job.courses.map(course => [course.courseId,
    lineage.map(id => store.getSnapshot(id, course.courseId)).find(Boolean)?.contentHash ?? null]));
  return {
    files: await desktopFiles(project.desktopDir),
    snapshots,
    courses: job.courses.map(course => ({ id: course.courseId, status: course.status, reason: course.reason })),
    changes: (await changeLogLines(project.projectDir)).map(({ runId: _runId, at: _at, ...rest }) => rest),
  };
}

async function uninterrupted() {
  const { project, collectors, model, fakes } = await scenario();
  const store = await storeOf(project);
  const pipeline = pipelineFor(project, store, fakes, { ids: ['run-u'] });
  const started = performance.now();
  await pipeline.start(ids);
  await pipeline.idle();
  return { project, store, outcome: await outcome(project, store, 'run-u'), collector: collectors.calls.length, model: model.count(),
    tokens: tokens(model.usage), ms: performance.now() - started };
}

type Boundary = { name: string; stage?: StageName; afterWrite?: true };
const boundaries: Boundary[] = [
  { name: 'collect → analyse', stage: 'collect' },
  { name: 'analyse → validate', stage: 'analyse' },
  { name: 'validate → merge', stage: 'validate' },
  { name: 'merge → done (file written, checkpoint not committed)', afterWrite: true },
];

/**
 * Hooks that crash at the boundary for course 2. Course 1 finishes first and course 3 waits before its collect until the
 * crash, so no other work is in flight when it happens (no call is half-made and repeated by the resume).
 */
function crashHooks(boundary: Boundary): PipelineHooks {
  const course1Merged = Promise.withResolvers<void>();
  const crashed = Promise.withResolvers<void>();
  const crash = async () => {
    await course1Merged.promise;
    // Release course 3 only after the pipeline has halted, so it cannot start a collector.
    setImmediate(() => crashed.resolve());
    throw new SimulatedCrash();
  };
  return {
    async beforeStage(stage, courseId) { if (stage === 'collect' && courseId === '900003') await crashed.promise; },
    async afterCheckpoint(stage, courseId) {
      if (stage === 'merge' && courseId === '900001') course1Merged.resolve();
      if (!boundary.afterWrite && stage === boundary.stage && courseId === '900002') await crash();
    },
    async afterMergeWrite(courseId) { if (boundary.afterWrite && courseId === '900002') await crash(); },
  };
}

async function crashed(boundary: Boundary) {
  const run = await scenario();
  const store = await storeOf(run.project);
  const pipeline = pipelineFor(run.project, store, run.fakes, { ids: ['run-a'], hooks: crashHooks(boundary) });
  const started = performance.now();
  await pipeline.start(ids);
  await pipeline.idle();
  const failedMs = performance.now() - started;
  return { ...run, store, failedMs, failed: { collector: run.collectors.calls.length, model: run.model.count(), tokens: tokens(run.model.usage) } };
}

const report: string[] = [];
afterAll(() => {
  if (report.length) console.info(['Resume vs restart (fake collectors, fake model: token counts are fake-model units, durations are local wall time with zero simulated latency):', ...report].join('\n'));
});

describe('fault injection at every stage boundary', () => {
  it.each(boundaries)('$name: resume equals an uninterrupted run without repeating finished work', async boundary => {
    const reference = await uninterrupted();
    const run = await crashed(boundary);

    // The crashed instance closed its database handle and left the job running; re-opening marks it interrupted.
    expect(() => run.store.getJob('run-a')).toThrow();
    const reopened = await storeOf(run.project);
    expect(reopened.getJob('run-a')).toMatchObject({ status: 'interrupted' });
    expect(reopened.getJob('run-a')!.courses.map(course => course.status)).toEqual(['completed', 'interrupted', 'interrupted', 'interrupted']);

    const before = { collectorCalls: [...run.collectors.calls], modelCalls: [...run.model.calls] };
    const resumer = pipelineFor(run.project, reopened, run.fakes, { ids: ['run-b'] });
    const started = performance.now();
    await resumer.resume('run-a');
    await resumer.idle();
    const resumeMs = performance.now() - started;
    const resumed = { collector: run.collectors.calls.slice(before.collectorCalls.length), model: run.model.calls.slice(before.modelCalls.length) };

    expect(reopened.getJob('run-b')).toMatchObject({ status: 'finished', resumedFrom: 'run-a' });
    expect(await outcome(run.project, reopened, 'run-b')).toEqual(reference.outcome);
    // The same number of collector and model calls in total as the uninterrupted run.
    expect(run.collectors.calls.length).toBe(reference.collector);
    expect(run.model.count()).toBe(reference.model);
    expect(tokens(run.model.usage)).toBe(reference.tokens);
    // Boundary-specific checks (design §10 table).
    expect(resumed.collector.filter(key => key.startsWith('900001:') || key.startsWith('900002:'))).toEqual([]);
    if (boundary.stage !== 'collect') expect(resumed.model.filter(id => id === '900001' || id === '900002')).toEqual([]);
    if (boundary.stage === 'validate' || boundary.afterWrite) expect(resumed.model.filter(id => id === '900002')).toEqual([]);
    if (boundary.afterWrite) {
      const folder = courseDir(run.project.desktopDir, courses[1]!);
      // The earlier file plus exactly one new course file (planned by the crashed job), and one change-log line.
      expect(Object.keys(await desktopFiles(run.project.desktopDir)).filter(name => name.includes('SYNT20002')).sort())
        .toEqual(['墨尔本大学 2026 S2/SYNT20002/分数结构-<run>.json', '墨尔本大学 2026 S2/SYNT20002/分数结构.json']);
      expect(existsSync(join(folder, '分数结构-run-a.json'))).toBe(true);
      expect(existsSync(join(folder, '分数结构-run-b.json'))).toBe(false);
      expect((await changeLogLines(run.project.projectDir)).filter(line => line.courseId === '900002')).toHaveLength(1);
      expect(reopened.getStage('run-b', '900002', 'merge')).toMatchObject({ status: 'succeeded', checkpoint: { completedFrom: 'run-a' } });
    }

    // Crash + fresh restart (a new sync of every course) for the comparison.
    const restart = await crashed(boundary);
    const restartStore = await storeOf(restart.project);
    const fresh = pipelineFor(restart.project, restartStore, restart.fakes, { ids: ['run-r'] });
    const restartTokens0 = tokens(restart.model.usage);
    const restartStarted = performance.now();
    await fresh.start(ids);
    await fresh.idle();
    const restartMs = performance.now() - restartStarted;
    const resumeTokens = tokens(run.model.usage) - run.failed.tokens;
    const restartTokens = tokens(restart.model.usage) - restartTokens0;
    expect(resumeTokens).toBeLessThan(restartTokens);
    // Restarting repeats exactly the model work the failed job had already finished.
    expect(restartTokens - resumeTokens).toBe(run.failed.tokens);
    // Calls are shown as collector/model counts (each collector call is one source of one course).
    const calls = (collector: number, modelCalls: number) => `${collector}/${modelCalls} calls`;
    report.push(`${boundary.name}: uninterrupted ${reference.tokens} tokens / ${calls(reference.collector, reference.model)} / ${reference.ms.toFixed(0)} ms; `
      + `failed job ${run.failed.tokens} tokens / ${calls(run.failed.collector, run.failed.model)} / ${run.failedMs.toFixed(0)} ms; `
      + `resume ${resumeTokens} tokens / ${calls(resumed.collector.length, resumed.model.length)} / ${resumeMs.toFixed(0)} ms; `
      + `fresh restart ${restartTokens} tokens / ${calls(restart.collectors.calls.length - restart.failed.collector, restart.model.count() - restart.failed.model)} / ${restartMs.toFixed(0)} ms; `
      + `failed + resume ${run.failed.tokens + resumeTokens} tokens, failed + restart ${run.failed.tokens + restartTokens} tokens`);
  });

  it('halts the whole instance: a course still analysing writes nothing after the crash and the run settles first', async () => {
    const project = await createProject(courses.slice(0, 2));
    projects.push(project);
    const collectors = fakeCollectors(courses);
    const model = fakeModel(courses, { SYNT10001: [{ hang: true }] });
    const store = await storeOf(project);
    const pipeline = pipelineFor(project, store, { runCollector: collectors.runCollector, callModel: model.callModel }, {
      ids: ['run-a'],
      hooks: { async afterCheckpoint(stage, courseId) {
        if (stage === 'collect' && courseId === '900002') { await expect.poll(() => model.count('900001'), { interval: 2 }).toBe(1); throw new SimulatedCrash(); }
      } },
    });
    await pipeline.start(['900001', '900002']);
    await pipeline.idle();
    expect(pipeline.running()).toBe(false);
    expect(() => store.getJob('run-a')).toThrow();
    const reopened = await storeOf(project);
    // Course 1's model call was stopped; its analyse row stayed `running` (now interrupted) and nothing later was written.
    expect(reopened.getStage('run-a', '900001', 'analyse')).toMatchObject({ status: 'interrupted' });
    expect(reopened.getStage('run-a', '900001', 'validate')).toBeNull();
    expect(reopened.getStage('run-a', '900001', 'merge')).toBeNull();
    expect(reopened.getJob('run-a')).toMatchObject({ status: 'interrupted', finishedAt: null });
    expect(await desktopFiles(project.desktopDir)).toEqual({});
    expect(existsSync(join(project.projectDir, '.local', 'lms', 'sync-errors'))).toBe(false);
  });

  it('copies a course merged just before the crash as done, with its result from the merge checkpoint', async () => {
    const reference = await uninterrupted();
    const run = await scenario();
    const store = await storeOf(run.project);
    const pipeline = pipelineFor(run.project, store, run.fakes, { ids: ['run-a'], hooks: crashHooks({ name: 'merge committed', stage: 'merge' }) });
    await pipeline.start(ids);
    await pipeline.idle();
    const reopened = await storeOf(run.project);
    expect(reopened.getJob('run-a')!.courses[1]).toMatchObject({ status: 'interrupted' });
    const resumer = pipelineFor(run.project, reopened, run.fakes, { ids: ['run-b'] });
    await resumer.resume('run-a');
    await resumer.idle();
    expect(reopened.getJob('run-b')!.courses[1]).toMatchObject({ status: 'completed', reused: true, file: join(courseDir(run.project.desktopDir, courses[1]!), '分数结构-run-a.json') });
    expect(await outcome(run.project, reopened, 'run-b')).toEqual(reference.outcome);
  });

  it('fails merge with MERGE_TARGET_CHANGED and keeps the file when the planned file was replaced', async () => {
    const run = await scenario();
    const store = await storeOf(run.project);
    const pipeline = pipelineFor(run.project, store, run.fakes, { ids: ['run-a'], hooks: crashHooks(boundaries[3]!) });
    await pipeline.start(ids);
    await pipeline.idle();
    const reopened = await storeOf(run.project);
    const planned = (reopened.getStage('run-a', '900002', 'merge')!.checkpoint as { plannedPath: string }).plannedPath;
    const { writeFile, readFile } = await import('node:fs/promises');
    await writeFile(planned, '{"edited": true}\n');
    const resumer = pipelineFor(run.project, reopened, run.fakes, { ids: ['run-b'] });
    await resumer.resume('run-a');
    await resumer.idle();
    expect(reopened.getStage('run-b', '900002', 'merge')).toMatchObject({ status: 'failed', errorCode: 'MERGE_TARGET_CHANGED' });
    expect(reopened.getJob('run-b')!.courses[1]).toMatchObject({ status: 'failed', stoppedStage: 'merge' });
    expect(await readFile(planned, 'utf8')).toBe('{"edited": true}\n');
    expect(reopened.getJob('run-b')!.status).toBe('failed');
  });
});
