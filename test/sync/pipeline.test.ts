import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun, AgentTool } from '../../src/agent/adapter.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { AgentSync, type JobSpec, type SyncPipeline } from '../../src/sync/agent-job.js';
import { canvasApiUrl, type CanvasTab, type GroupsStage, type TabsStage } from '../../src/sync/canvas-api.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { component, document, item } from './course-document.js';

type Call = (name: string, input: unknown) => Promise<unknown>;
type Script = (spec: JobSpec, call: Call) => AsyncGenerator<AgentEvent, void>;
type Behaviour = 'ok' | 'error' | 'unavailable' | 'timeout' | 'result-only';

/** Synthetic agent: the pipeline's prompt is the JobSpec JSON, so the script knows which job it is running. */
class PipelineAgent implements AgentAdapter {
  readonly id = 'synthetic';
  readonly inputs: AgentInput[] = [];
  readonly specs: JobSpec[] = [];
  interrupted = 0;
  constructor(private readonly script: Script) {}
  start(input: AgentInput): AgentRun {
    this.inputs.push(input);
    const spec = JSON.parse(input.prompt) as JobSpec;
    this.specs.push(spec);
    const call: Call = async (name, args) => {
      const tool = input.tools.find(entry => entry.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return await tool.execute(args);
    };
    const self = this;
    return { [Symbol.asyncIterator]: () => self.script(spec, call), interrupt() { self.interrupted++; } };
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const canvasA = 'https://canvas.lms.unimelb.edu.au/courses/900001';
const canvasB = 'https://canvas.lms.unimelb.edu.au/courses/900002';
const edA = 'https://edstem.org/au/courses/800001';
const keyA = 'SYNA10001:2026:S2';
const keyB = 'SYNB20002:2026:S2';
const pagesA = { canvas: canvasA };
const pagesB = { canvas: canvasB };
const allCourses = [
  { code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2', pages: pagesA },
  { code: 'SYNB20002', term: '2026:S2', pages: pagesB },
];

const selection = (key: string, pages: { canvas?: string; ed?: string } = pagesA) => ({
  key, code: key.split(':')[0]!, term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true,
});
const seed = (store: SqliteRepository, ...keys: string[]): void => {
  store.saveCourseSelections(keys.map(key => selection(key, key === keyB ? pagesB : pagesA)));
};
const docFor = (key: string): unknown => {
  const code = key.split(':')[0]!;
  const pages = code === 'SYNA10001' ? pagesA : pagesB;
  const url = `${pages.canvas}/assignments/1`;
  return document([component('assignments', 60, [item(1, { url }, code)])], { pages }, code, '2026:S2');
};
const canvasId = (key: string): string => key === keyB ? '900002' : '900001';

const tab = (id: string, label: string, url: string): CanvasTab => ({ id, label, type: 'synthetic', url });
function tabsFor(key: string, extra: CanvasTab[] = []): TabsStage {
  const id = canvasId(key);
  return { source: canvasApiUrl('tabs', id), via: 'api', tabs: [
    tab('home', 'Home', `${canvasA.replace(/900001$/, id)}`),
    tab('modules', 'Modules', `https://canvas.lms.unimelb.edu.au/courses/${id}/modules`),
    tab('quizzes', 'Quizzes', `https://canvas.lms.unimelb.edu.au/courses/${id}/quizzes`),
    tab('grades', 'Grades', `https://canvas.lms.unimelb.edu.au/courses/${id}/grades`),
    tab('pages', 'Pages', `https://canvas.lms.unimelb.edu.au/courses/${id}/pages`),
    tab('files', 'Files', `https://canvas.lms.unimelb.edu.au/courses/${id}/files`),
    ...extra,
  ] };
}
function groupsFor(key: string, coverage: 'api' | 'partial' = 'api'): GroupsStage {
  const id = canvasId(key);
  const group = { id: '1', name: 'Assignments', weight: { value: 60, state: 'found' as const, via: 'api' as const } };
  return { source: canvasApiUrl('groups', id), via: 'api', coverage, unweighted: false, groups: [{
    ...group,
    assignments: [{ id: '1', name: 'Synthetic item 1', courseId: id, assignmentGroupId: '1',
      htmlUrl: `https://canvas.lms.unimelb.edu.au/courses/${id}/assignments/1`, group,
      due: { value: null, state: 'unknown' as const }, unlockAt: { value: null, state: 'unknown' as const },
      outOf: { value: 10, state: 'found' as const }, score: { value: null, state: 'unknown' as const },
      status: { value: 'not_started' as const, state: 'found' as const }, updatedAt: { value: null, state: 'unknown' as const } }],
  }] };
}

interface BehaviourOptions {
  behaviour?: (spec: JobSpec) => Behaviour;
  tabs?: (spec: JobSpec) => TabsStage;
  groups?: (spec: JobSpec) => GroupsStage;
  map?: (spec: JobSpec) => unknown;
}
/** The ordinary successful job: one output tool call, one tool step, then a result event. */
function scripted(options: BehaviourOptions = {}): Script {
  return async function* (spec, call) {
    const behaviour = options.behaviour?.(spec) ?? 'ok';
    if (behaviour === 'timeout') { await new Promise(() => {}); return; }
    if (behaviour === 'error') { yield { type: 'error', code: 'INTERNAL', message: 'Synthetic failure' }; return; }
    if (behaviour === 'unavailable') { yield { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Synthetic unavailable' }; return; }
    if (behaviour === 'result-only') { yield { type: 'result', turns: 1 }; return; }
    switch (spec.kind) {
      case 'courses': await call('courses.offer', { jobId: spec.jobId, courses: allCourses, blocked: [] }); break;
      case 'handbook': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'skeleton',
        value: { source: 'synthetic handbook', via: 'handbook', components: [] } }); break;
      case 'tabs': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'tabs',
        value: options.tabs?.(spec) ?? tabsFor(spec.courseKey!) }); break;
      case 'groups': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'groups',
        value: options.groups?.(spec) ?? groupsFor(spec.courseKey!) }); break;
      case 'main': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'map',
        value: options.map?.(spec) ?? { links: [] } }); break;
      case 'quizzes': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'quizzes', value: { quizzes: [] } }); break;
      case 'assignment': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey,
        stage: `assignments.${spec.target}`, value: { policy: 'unknown', files: [] } }); break;
      case 'saver': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'materials', value: { files: [], links: [] } }); break;
      case 'ed': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'ed', value: { lessons: [] } }); break;
      case 'classify': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'classification', value: { items: [] } }); break;
    }
    yield { type: 'tool_step', tool: `coursework.${spec.kind}`, outcome: 'ok' };
    yield { type: 'result', turns: 1 };
  };
}

interface SetupOptions extends BehaviourOptions {
  script?: Script;
  runBoundMs?: number;
  jobBoundMs?: number;
  parallel?: number;
  path?: boolean;
  build?: SyncPipeline['build'];
  ed?: SyncPipeline['ed'];
  archive?: SyncPipeline['archive'];
}
function setup(options: SetupOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-')));
  const databasePath = join(directory, 'coursework.sqlite');
  const store = new SqliteRepository(options.path ? databasePath : ':memory:');
  const clipboard = { text: '', read() { return clipboard.text; } };
  const jobs = new SyncJobs(store, { clipboard });
  const tools: AgentTool[] = [
    { name: 'stage.write', description: 'Store one pipeline stage', inputSchema: {}, execute: async input => {
      const { jobId, courseKey, stage, value } = input as { jobId: string; courseKey: string; stage: string; value: unknown };
      return jobs.recordStage(jobId, courseKey, stage, value);
    } },
    { name: 'courses.offer', description: 'Offer courses', inputSchema: {}, execute: async input => jobs.offer(input as Parameters<SyncJobs['offer']>[0]) },
    { name: 'canvas.capture', description: 'Capture a Canvas page', inputSchema: {}, execute: async input => jobs.capture(input as Parameters<SyncJobs['capture']>[0]) },
    { name: 'handbook.capture', description: 'Capture the Handbook', inputSchema: {}, execute: async input => jobs.handbook(input as Parameters<SyncJobs['handbook']>[0]) },
  ];
  const adapter = new PipelineAgent(options.script ?? scripted(options));
  const pipeline: SyncPipeline = {
    prompt: spec => JSON.stringify(spec),
    tools: () => tools,
    build: options.build ?? ((key: string) => docFor(key)),
    ...(options.ed ? { ed: options.ed } : {}),
    ...(options.archive ? { archive: options.archive } : {}),
    ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
  };
  const sync = new AgentSync({ store, jobs, adapter: () => adapter, tools: () => tools, pipeline,
    ...(options.runBoundMs !== undefined ? { runBoundMs: options.runBoundMs } : {}),
    ...(options.jobBoundMs !== undefined ? { jobBoundMs: options.jobBoundMs } : {}) });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, jobs, sync, adapter, tools, directory, databasePath };
}

describe('layered sync pipeline (layered-sync task 5.1, step 2)', () => {
  it('One course at a time: when the second course fails throughout, the first stays stored and the second keeps its old data', async () => {
    let failSecond = false;
    const f = setup({ behaviour: spec => failSecond && spec.courseKey === keyB ? 'unavailable' : 'ok' });
    seed(f.store, keyA, keyB);
    const first = await f.sync.run({});
    expect(first.outcome).toBe('OK');
    const storedB = f.sync.status().courses.find(course => course.key === keyB)!.storedAt;
    expect(storedB).toBeDefined();
    failSecond = true;

    const second = await f.sync.run({});
    expect(second.outcome).toBe('PARTIAL');
    expect(second.run.courseCoverage?.map(coverage => coverage.stored)).toEqual([true, false]);
    expect(f.sync.status().courses.find(course => course.key === keyB)!.storedAt).toBe(storedB);
    expect(second.run.jobs?.filter(job => job.courseKey === keyB).length).toBeGreaterThan(0);
    expect(second.run.jobs?.filter(job => job.courseKey === keyB).every(job => job.outcome !== 'ok')).toBe(true);
    // The first course was imported before the second course's first job started.
    expect(f.adapter.specs.filter(spec => spec.courseKey === keyA).length).toBeGreaterThan(0);
  });

  it('Per-job record: every attempt is listed, and a failed job appears twice but not three times', async () => {
    const f = setup({ behaviour: spec => spec.kind === 'main' ? 'error' : 'ok' });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    const main = result.run.jobs?.filter(job => job.kind === 'main') ?? [];
    expect(main).toHaveLength(2);
    expect(main).toEqual([
      { kind: 'main', courseKey: keyA, steps: 0, turns: 0, outcome: 'error' },
      { kind: 'main', courseKey: keyA, steps: 0, turns: 0, outcome: 'error' },
    ]);
    expect(result.run.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'courses', steps: 1, turns: 1, outcome: 'ok' }),
      expect.objectContaining({ kind: 'tabs', courseKey: keyA, steps: 1, turns: 1, outcome: 'ok' }),
      expect.objectContaining({ kind: 'classify', courseKey: keyA, steps: 1, turns: 1, outcome: 'ok' }),
    ]));
  });

  it('Job bound: a job that never ends is interrupted, recorded timeout twice, and the course continues', async () => {
    const f = setup({ behaviour: spec => spec.kind === 'main' ? 'timeout' : 'ok', jobBoundMs: 40 });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    const main = result.run.jobs?.filter(job => job.kind === 'main') ?? [];
    expect(main.map(job => job.outcome)).toEqual(['timeout', 'timeout']);
    expect(f.adapter.interrupted).toBe(2);
    expect(result.run.courseCoverage?.[0]?.stored).toBe(true);
    expect(f.store.query('assessments', { limit: 10 }).items.length).toBeGreaterThan(0);
  });

  it('a result event without the expected stage is a failed job (only tool results count)', async () => {
    const f = setup({ behaviour: spec => spec.kind === 'main' ? 'result-only' : 'ok' });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.run.jobs?.filter(job => job.kind === 'main').map(job => job.outcome)).toEqual(['error', 'error']);
    expect(result.run.courseCoverage?.[0]?.stored).toBe(true);
  });

  it('Run bound: hitting it records TIMEOUT, stops, and keeps the courses already imported', async () => {
    const f = setup({ behaviour: spec => spec.courseKey === keyB ? 'timeout' : 'ok', runBoundMs: 700 });
    seed(f.store, keyA, keyB);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('TIMEOUT');
    expect(result.run.syncOutcome).toBe('TIMEOUT');
    expect(result.run.courseCoverage?.map(coverage => coverage.stored)).toEqual([true, false]);
  });

  it('Stage results are shared across processes: a map stored by a second SyncJobs starts the routed jobs', async () => {
    let other: SyncJobs | undefined;
    const base = scripted();
    const files = `${canvasA}/files/folder/1`;
    const f = setup({ path: true, script: async function* (spec, call) {
      if (spec.kind === 'main') {
        other!.recordStage(spec.jobId, spec.courseKey!, 'map', { links: [{ label: 'Files', url: files }] });
        yield { type: 'tool_step', tool: 'coursework.course.map', outcome: 'ok' };
        yield { type: 'result', turns: 1 };
        return;
      }
      yield* base(spec, call);
    } });
    const otherStore = new SqliteRepository(f.databasePath);
    other = new SyncJobs(otherStore);
    cleanups.push(() => { otherStore.close(); });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    const saver = f.adapter.specs.find(spec => spec.kind === 'saver');
    expect(saver?.urls).toContain(files);
  });

  it('Second start during a pipeline run is LOCKED and starts nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = scripted();
    const f = setup({ script: async function* (spec, call) {
      if (spec.kind === 'handbook') await gate;
      yield* base(spec, call);
    } });
    seed(f.store, keyA);
    const first = f.sync.run({});
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(f.sync.run({})).rejects.toMatchObject({ code: 'LOCKED' });
    release();
    await first;
  });

  it('Order: one course follows the D1 order and its import happens before the next course starts', async () => {
    const events: string[] = [];
    const base = scripted();
    const f = setup({ script: async function* (spec, call) {
      events.push(`start:${spec.courseKey ?? 'all'}:${spec.kind}`);
      yield* base(spec, call);
    }, build: (key, stages) => { events.push(`build:${key}`); expect(stages.tabs).toBeDefined(); return docFor(key); } });
    seed(f.store, keyA, keyB);
    await f.sync.run({});
    const kindsA = f.adapter.specs.filter(spec => spec.courseKey === keyA).map(spec => spec.kind);
    expect(kindsA).toEqual(['handbook', 'tabs', 'groups', 'main', 'quizzes', 'assignment', 'saver', 'classify']);
    const kindsB = f.adapter.specs.filter(spec => spec.courseKey === keyB).map(spec => spec.kind);
    expect(kindsB).toEqual(kindsA);
    expect(events.indexOf(`build:${keyA}`)).toBeGreaterThan(events.indexOf(`start:${keyA}:classify`));
    expect(events.indexOf(`start:${keyB}:handbook`)).toBeGreaterThan(events.indexOf(`build:${keyA}`));
  });

  it('Handbook unavailable: two failed handbook jobs do not stop the course, and the build sees no skeleton', async () => {
    let stagesSeen: Record<string, unknown> | undefined;
    const f = setup({ behaviour: spec => spec.kind === 'handbook' ? 'unavailable' : 'ok',
      build: (key, stages) => { stagesSeen = stages; return docFor(key); } });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    const handbook = result.run.jobs?.filter(job => job.kind === 'handbook') ?? [];
    expect(handbook.map(job => job.outcome)).toEqual(['error', 'error']);
    expect(result.run.courseCoverage?.[0]?.stored).toBe(true);
    expect(stagesSeen?.skeleton).toBeUndefined();
    expect(stagesSeen?.tabs).toBeDefined();
  });

  it('Gradescope never opened: no JobSpec contains the Gradescope, Echo360 or grades tab URL', async () => {
    const gradesUrl = `${canvasA}/grades`;
    const gradescope = 'https://gradescope.example.edu/course/1';
    const echo360 = 'https://echo360.example.edu/section/1';
    const tabs = tabsFor(keyA, [
      { id: 'context_external_tool_1', label: 'Gradescope', type: 'external', url: gradescope },
      { id: 'context_external_tool_2', label: 'Echo360', type: 'external', url: echo360 },
    ]);
    const f = setup({ tabs: () => tabs });
    seed(f.store, keyA);
    await f.sync.run({});
    const urls = f.adapter.specs.flatMap(spec => spec.urls);
    for (const forbidden of [gradesUrl, gradescope, echo360]) expect(urls).not.toContain(forbidden);
  });

  it('Files only through the home page: a mapped Files folder reaches the saver; without the link no job gets one', async () => {
    const files = `${canvasA}/files/folder/1`;
    const withLink = setup({ map: () => ({ links: [{ label: 'Course files', url: files }] }) });
    seed(withLink.store, keyA);
    await withLink.sync.run({});
    expect(withLink.adapter.specs.find(spec => spec.kind === 'saver')?.urls).toContain(files);

    const withoutLink = setup({ map: () => ({ links: [] }) });
    seed(withoutLink.store, keyA);
    await withoutLink.sync.run({});
    const urls = withoutLink.adapter.specs.flatMap(spec => spec.urls);
    expect(urls.some(url => url.startsWith(`${canvasA}/files`))).toBe(false);
  });

  it('Default sequential: routed jobs do not overlap unless parallel is set', async () => {
    let active = 0;
    let max = 0;
    const base = scripted();
    const f = setup({ script: async function* (spec, call) {
      if (spec.kind === 'quizzes' || spec.kind === 'saver') {
        active++; max = Math.max(max, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;
      }
      yield* base(spec, call);
    } });
    seed(f.store, keyA);
    await f.sync.run({});
    expect(max).toBe(1);
  });

  it('Parallel jobs are opt-in: parallel 2 lets two routed jobs overlap', async () => {
    let started = 0;
    let max = 0;
    let releaseBoth!: () => void;
    const both = new Promise<void>(resolve => { releaseBoth = resolve; });
    const base = scripted();
    const f = setup({ parallel: 2, script: async function* (spec, call) {
      if (spec.kind === 'quizzes' || spec.kind === 'saver') {
        started++; max = Math.max(max, started);
        if (started === 2) releaseBoth();
        await both;
      }
      yield* base(spec, call);
    } });
    seed(f.store, keyA);
    await f.sync.run({});
    expect(max).toBeGreaterThanOrEqual(2);
  });

  it('Canvas numbers come from the groups stage; missing groups reports unavailable', async () => {
    const f = setup({ groups: spec => spec.courseKey === keyA ? groupsFor(keyA, 'partial') : groupsFor(keyB) });
    seed(f.store, keyA, keyB);
    const result = await f.sync.run({});
    expect(result.run.courseCoverage?.map(coverage => coverage.canvasNumbers)).toEqual(['partial', 'api']);

    const noGroups = setup({ behaviour: spec => spec.kind === 'groups' ? 'unavailable' : 'ok' });
    seed(noGroups.store, keyA);
    const missing = await noGroups.sync.run({});
    expect(missing.run.courseCoverage?.[0]?.canvasNumbers).toBe('unavailable');
  });

  it('A failed courses job does not stop previously selected courses', async () => {
    const f = setup({ behaviour: spec => spec.kind === 'courses' ? 'error' : 'ok' });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    expect(result.run.jobs?.filter(job => job.kind === 'courses').map(job => job.outcome)).toEqual(['error', 'error']);
    expect(result.run.courseCoverage?.[0]?.stored).toBe(true);
  });

  it('A build failure for one course keeps its old data and the run continues with the next course', async () => {
    let failA = false;
    const f = setup({ build: (key, stages) => {
      expect(stages.tabs).toBeDefined();
      if (failA && key === keyA) throw new Error('Synthetic build failure');
      return docFor(key);
    } });
    seed(f.store, keyA, keyB);
    expect((await f.sync.run({})).outcome).toBe('OK');
    const storedA = f.sync.status().courses.find(course => course.key === keyA)!.storedAt;
    failA = true;
    const result = await f.sync.run({});
    expect(result.outcome).toBe('PARTIAL');
    expect(result.run.courseCoverage?.map(coverage => coverage.stored)).toEqual([false, true]);
    expect(f.sync.status().courses.find(course => course.key === keyA)!.storedAt).toBe(storedA);
  });

  it('Ed: no hook means one Ed job when the course has an Ed page; a hook replaces it', async () => {
    const withJob = setup();
    withJob.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
    await withJob.sync.run({});
    const edS = withJob.adapter.specs.find(spec => spec.kind === 'ed');
    expect(edS?.urls).toEqual([edA]);

    let hookCalls = 0;
    const withHook = setup({ ed: () => { hookCalls++; } });
    withHook.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
    await withHook.sync.run({});
    expect(hookCalls).toBe(1);
    expect(withHook.adapter.specs.some(spec => spec.kind === 'ed')).toBe(false);
  });
});
