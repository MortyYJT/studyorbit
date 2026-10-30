import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncPipeline } from '../scripts/lib/sync-pipeline.mjs';
import type { SyncStore } from '../scripts/lib/sync-store.mjs';
import {
  changeLogLines, createProject, desktopFiles, fakeCollectors, fakeModel, openStore, pipelineFor, START, syntheticCourse, usageLines,
  writeEarlierDocument, type Project, type SyntheticCourse,
} from './sync-fakes.ts';

// The sync-incomplete change (decisions #480-#489): collector causes in reasons, the preflight before any collector or
// model call, incomplete syncs that keep the previous document, and leaves without references when no framework
// component is available. Temporary project and Desktop, fake collectors and a fake model only.
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
async function store() {
  const opened = await openStore(project!.projectDir, () => START);
  stores.push(opened);
  return opened;
}
async function run(pipeline: SyncPipeline, start: () => Promise<unknown>) {
  await start();
  await pipeline.idle();
  return pipeline.status();
}
const ids = (courses: SyntheticCourse[]) => courses.map(course => course.id);
const syncErrors = async () => { try { return (await readdir(join(project!.projectDir, '.local', 'lms', 'sync-errors'))).sort(); } catch { return []; } };
const WINDOW = 'Canvas 后台采集失败：execution error: Microsoft Edge got an error: EDGE_WINDOW_MISSING (-2700)。如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。';
const SIGNED_OUT = 'Canvas 后台采集失败：Canvas HTTP 401。如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。';
/** The fixture output without framework references: what a model answers when the Handbook was not collected. */
const withoutFramework = (output: { document: { assessments: { refs: { platform: string }[] }[] } }) => {
  for (const item of output.document.assessments) item.refs = item.refs.filter(ref => ref.platform !== 'handbook');
};

describe('preflight before collecting', () => {
  it('stops the job with the browser cause before any collector or model call, and writes nothing', async () => {
    const courses = await setup(2, { earlier: [1] });
    const collectors = fakeCollectors(courses, { 'preflight:canvas': { exit: [1], error: WINDOW } });
    const model = fakeModel(courses);
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const before = await desktopFiles(project!.desktopDir);
    const status = await run(pipeline, () => pipeline.start(ids(courses)));

    const reason = 'Edge 没有打开窗口，请打开一个 Edge 窗口后重试';
    expect(status.courses.map(course => [course.status, course.reason])).toEqual([['failed', reason], ['failed', reason]]);
    expect(status).toMatchObject({ error: reason, resumable: true, running: false });
    expect(collectors.preflights).toEqual(['preflight:canvas']);
    expect(collectors.calls).toEqual([]);
    expect(model.count()).toBe(0);
    expect(await desktopFiles(project!.desktopDir)).toEqual(before);
    expect(await changeLogLines(project!.projectDir)).toEqual([]);
    expect(db.getStage('run-1', '900001', 'collect')).toBeNull();
    expect(db.getJob('run-1')).toMatchObject({ status: 'failed', error: reason });
    // One usage line per course, with no model usage.
    const lines = (await usageLines(project!.projectDir)).filter(line => line.course);
    expect(lines.map(line => [line.course, line.status, line.coordinator])).toEqual([['SYNT10001', 'failed', null], ['SYNT20002', 'failed', null]]);
  });

  it('reports an expired Canvas sign-in, and a resume after signing in runs the sync', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses, { 'preflight:canvas': { exit: [1, 0], error: SIGNED_OUT } });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1', 'run-2'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'failed', reason: 'Canvas 登录已失效，请在 Edge 里重新登录 Canvas' });
    const resumed = await run(pipeline, () => pipeline.resume('run-1'));
    expect(resumed.courses[0]).toMatchObject({ status: 'completed' });
    expect(collectors.preflights).toEqual(['preflight:canvas', 'preflight:canvas', 'preflight:ed']);
  });

  it('only warns when Ed is signed out, and the sync goes on', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses, { 'preflight:ed': { exit: [1], error: 'ED_SIGNED_OUT' } });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'completed' });
    expect(status.warnings).toEqual(['Ed 检查未通过（Ed 未登录，请在终端运行 edstem auth login 后重试），Ed 数据可能缺失，同步照常进行']);
    expect(db.getJob('run-1')!.warnings).toEqual(status.warnings);
    expect(collectors.calls).toHaveLength(3);
  });

  it('is skipped when every remaining course reuses its collected data', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses);
    const model = fakeModel(courses, { SYNT10001: [{ status: 429 }, { status: 429 }, { status: 429 }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1', 'run-2'] });
    await run(pipeline, () => pipeline.start(ids(courses)));
    expect(collectors.preflights).toHaveLength(2);
    const resumed = await run(pipeline, () => pipeline.resume('run-1'));
    expect(resumed.courses[0]).toMatchObject({ status: 'completed' });
    expect(collectors.preflights).toHaveLength(2);
  });
});

describe('collector causes in reasons', () => {
  it('stores the cause in the placeholder and the course reason', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses, { '900001:handbook': { exit: [1], timedOut: true, error: '' } });
    const db = await store();
    const model = fakeModel(courses, { SYNT10001: [{ edit: withoutFramework }] });
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    const file = (db.getStage('run-1', '900001', 'collect')!.checkpoint as { sources: { handbook: { file: string } } }).sources.handbook.file;
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ status: 'unavailable', reason: 'Handbook 采集超时，请检查网络和浏览器后重试' });
    expect(status.courses[0]!.reason).toMatch(/^Handbook 数据未能读取（Handbook 采集超时，请检查网络和浏览器后重试）；/);
  });
});

describe('an incomplete sync keeps the previous document', () => {
  it('saves nothing to the Desktop or the change log when Canvas failed and an earlier document exists', async () => {
    const courses = await setup(2, { earlier: [1, 2] });
    const collectors = fakeCollectors(courses, { '900001:canvas': { exit: [1], error: SIGNED_OUT } });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    const before = await desktopFiles(project!.desktopDir);
    const status = await run(pipeline, () => pipeline.start(ids(courses)));

    expect(status.courses[0]).toMatchObject({ status: 'incomplete', reason: 'Canvas 登录已失效，请在 Edge 里重新登录 Canvas', stage: 'merge' });
    expect(status.courses[0]).not.toHaveProperty('file');
    expect(status.courses[1]).toMatchObject({ status: 'completed' });
    const after = await desktopFiles(project!.desktopDir);
    expect(Object.keys(after).filter(name => name.includes('SYNT10001'))).toEqual(Object.keys(before).filter(name => name.includes('SYNT10001')));
    expect((await changeLogLines(project!.projectDir)).map(line => line.courseId)).toEqual(['900002']);
    // The reply cites Canvas assignments that were not collected, so it was rejected: no snapshot, only the diagnostic.
    expect(db.getSnapshot('run-1', '900001')).toBeNull();
    expect(await syncErrors()).toContain('run-1-900001-incomplete.json');
    const diagnostic = JSON.parse(await readFile(join(project!.projectDir, '.local', 'lms', 'sync-errors', 'run-1-900001-incomplete.json'), 'utf8'));
    expect(diagnostic).toMatchObject({ status: 'incomplete', missing: [{ id: 'canvas', label: 'Canvas', reason: 'Canvas 登录已失效，请在 Edge 里重新登录 Canvas' }],
      analysed: { status: 'failed', document: null } });
    expect(db.getJob('run-1')!.status).toBe('finished');
  });

  it('keeps an analysed document of an incomplete sync only in the snapshot and the diagnostic', async () => {
    const courses = await setup(1, { earlier: [1] });
    const collectors = fakeCollectors(courses, { '900001:handbook': { exit: [1], error: WINDOW } });
    const model = fakeModel(courses, { SYNT10001: [{ edit: withoutFramework }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const before = await desktopFiles(project!.desktopDir);
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'incomplete', reason: 'Edge 没有打开窗口，请打开一个 Edge 窗口后重试' });
    expect(await desktopFiles(project!.desktopDir)).toEqual(before);
    expect(await changeLogLines(project!.projectDir)).toEqual([]);
    const snapshot = db.getSnapshot('run-1', '900001')!;
    expect(snapshot).toMatchObject({ status: 'incomplete', file: null, version: 2 });
    expect(JSON.parse(snapshot.document).assessments.map((item: { id: string }) => item.id)).toContain('item:lab-attendance-hurdle');
    const diagnostic = JSON.parse(await readFile(join(project!.projectDir, '.local', 'lms', 'sync-errors', 'run-1-900001-incomplete.json'), 'utf8'));
    expect(diagnostic.analysed).toMatchObject({ status: 'partial', document: { version: 2 } });
  });

  it('is incomplete when the Ed collector failed outright, but not when Ed data is partial', async () => {
    const courses = await setup(2, { earlier: [1, 2] });
    const collectors = fakeCollectors(courses, { '900001:ed': { exit: [1], error: 'ED_SIGNED_OUT' }, '900002:ed': { partial: true } });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: fakeModel(courses).callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses.map(course => [course.status, course.reason])).toEqual([
      ['incomplete', 'Ed 未登录，请在终端运行 edstem auth login 后重试'], ['partial', '部分 Ed 数据未能读取；'],
    ]);
  });

  it('saves a first sync as partial when the Handbook failed, with leaves without references allowed', async () => {
    const courses = await setup(1);
    const collectors = fakeCollectors(courses, { '900001:handbook': { exit: [1], error: WINDOW } });
    const model = fakeModel(courses, { SYNT10001: [{ edit: withoutFramework }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1'] });
    const status = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(status.courses[0]).toMatchObject({ status: 'partial' });
    expect(status.courses[0]!.reason).toMatch(/^Handbook 数据未能读取（Edge 没有打开窗口，请打开一个 Edge 窗口后重试）；1 项考核没有来源引用；/);
    const saved = JSON.parse(Object.values(await desktopFiles(project!.desktopDir))[0]!);
    const lab = saved.assessments.find((item: { name: string }) => item.name === 'Lab Attendance Hurdle');
    expect(lab).toMatchObject({ id: 'item:lab-attendance-hurdle', refs: [], sources: [] });
    expect(model.count()).toBe(1);
  });

  it('copies an incomplete course as done when the job is resumed for another course', async () => {
    const courses = await setup(2, { earlier: [1] });
    const collectors = fakeCollectors(courses, { '900001:canvas': { exit: [1], error: SIGNED_OUT } });
    const model = fakeModel(courses, { SYNT20002: [{ status: 429 }, { status: 429 }, { status: 429 }] });
    const db = await store();
    const pipeline = pipelineFor(project!, db, { runCollector: collectors.runCollector, callModel: model.callModel }, { ids: ['run-1', 'run-2'] });
    const first = await run(pipeline, () => pipeline.start(ids(courses)));
    expect(first.courses.map(course => course.status)).toEqual(['incomplete', 'failed']);
    const calls = model.count('900001');
    const resumed = await run(pipeline, () => pipeline.resume('run-1'));
    expect(resumed.courses.map(course => [course.status, course.reused])).toEqual([['incomplete', true], ['completed', false]]);
    expect(resumed.courses[0]!.reason).toBe('Canvas 登录已失效，请在 Edge 里重新登录 Canvas');
    expect(model.count('900001')).toBe(calls);
    expect((await desktopFiles(project!.desktopDir))).not.toHaveProperty('墨尔本大学 2026 S2/SYNT10001/分数结构-<run>.json');
  });
});
