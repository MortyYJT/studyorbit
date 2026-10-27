import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun, AgentTool } from '../../src/agent/adapter.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { AgentSync, type JobSpec, type PipelineJobContext, type SyncPipeline } from '../../src/sync/agent-job.js';
import { canvasApiUrl, type CanvasTab, type GroupsStage, type TabsStage } from '../../src/sync/canvas-api.js';
import { edHook, type EdCommandResult, type EdRunner } from '../../src/sync/ed-cli.js';
import { assessmentId } from '../../src/sync/course-import.js';
import type { ExtensionReader } from '../../src/sync/extension-bridge.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { buildCourseDocument } from '../../src/sync/build-document.js';
import type { CourseDocument } from '../../src/sync/course-json.js';
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
const ok = (stdout: string): EdCommandResult => ({ code: 0, stdout });
const keyA = 'SYNA10001:2026:S2';
const keyB = 'SYNB20002:2026:S2';
const pagesA = { canvas: canvasA };
const pagesB = { canvas: canvasB };
const selection = (key: string, pages: { canvas?: string; ed?: string } = pagesA) => ({
  key, code: key.split(':')[0]!, term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true,
});
const seed = (store: SqliteRepository, ...keys: string[]): void => {
  store.saveCourseSelections(keys.map(key => selection(key, key === keyB ? pagesB : pagesA)));
};
const docFor = (key: string): CourseDocument => {
  const code = key.split(':')[0]!;
  const pages = code === 'SYNA10001' ? pagesA : pagesB;
  const url = `${pages.canvas}/assignments/1`;
  return document([component('assignments', 60, [item(1, { url, kind: { value: 'assignment', state: 'found', via: 'ax' } }, code)])],
    { pages }, code, '2026:S2') as CourseDocument;
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
  const source = canvasApiUrl('groups', id);
  const at = '2026-10-24T00:00:00Z';
  const group = { id: '1', name: 'Assignments', weight: { value: 60, state: 'found' as const, via: 'api' as const, source } };
  return { source, via: 'api', coverage, unweighted: false, groups: [{
    ...group,
    assignments: [{ id: '1', name: 'Synthetic item 1', courseId: id, assignmentGroupId: '1',
      htmlUrl: `https://canvas.lms.unimelb.edu.au/courses/${id}/assignments/1`, group,
      due: { value: null, state: 'unknown' as const, checkedAt: at }, unlockAt: { value: null, state: 'unknown' as const, checkedAt: at },
      outOf: { value: 10, state: 'found' as const, via: 'api' as const, source }, score: { value: null, state: 'unknown' as const, checkedAt: at },
      status: { value: 'not_started' as const, state: 'found' as const, via: 'api' as const, source },
      updatedAt: { value: null, state: 'unknown' as const, checkedAt: at } }],
  }] };
}

/** The production build, wired into the fake adapter: the same function 6.2 adds. */
const realBuild: SyncPipeline['build'] = (_key, stages, ctx) => {
  if (!ctx) throw new Error('build needs the course context');
  return buildCourseDocument({ course: ctx.course, stages, now: ctx.now,
    ...(ctx.resolved ? { resolved: ctx.resolved } : {}), ...(ctx.blocked ? { blocked: ctx.blocked } : {}) });
};
const handbookPage = 'https://handbook.unimelb.edu.au/2026/subjects/syna10001/assessment';
const skeletonFor = (components: { name: string; weight?: number; hurdle?: string }[]) => ({ source: handbookPage, via: 'handbook',
  components: components.map(component => ({ ...component, quote: `${component.name}\tSynthetic timing\t${component.weight ?? 0}%` })) });
const classifyAs = (items: { id: string; category: string; component?: string; evidence: string }[]) => ({ items });
/** One weighted group "Assignments" with a known API `updatedAt`, so the skip rule can compare it. */
function groupsWith(weight: number, options: { coverage?: 'api' | 'partial'; updatedAt?: string } = {}): GroupsStage {
  const base = groupsFor(keyA, options.coverage ?? 'api');
  const group = base.groups[0]!;
  const updatedAt = { value: options.updatedAt ?? '2026-10-20T08:00:00Z', state: 'found' as const, via: 'api' as const, source: base.source };
  return { ...base, groups: [{ ...group, weight: { ...group.weight, value: weight },
    assignments: [{ ...group.assignments[0]!, group: { ...group, weight: { ...group.weight, value: weight } }, updatedAt }] }] };
}

interface BehaviourOptions {
  behaviour?: (spec: JobSpec) => Behaviour;
  tabs?: (spec: JobSpec) => TabsStage;
  groups?: (spec: JobSpec) => GroupsStage;
  skeleton?: (spec: JobSpec) => unknown;
  classification?: (spec: JobSpec) => unknown;
  assignment?: (spec: JobSpec) => unknown;
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
      case 'handbook': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'skeleton',
        value: options.skeleton?.(spec) ?? { source: 'synthetic handbook', via: 'handbook', components: [] } }); break;
      case 'tabs': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'tabs',
        value: options.tabs?.(spec) ?? tabsFor(spec.courseKey!) }); break;
      case 'groups': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'groups',
        value: options.groups?.(spec) ?? groupsFor(spec.courseKey!) }); break;
      case 'main': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'map',
        value: options.map?.(spec) ?? { links: [] } }); break;
      case 'quizzes': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'quizzes', value: { quizzes: [] } }); break;
      case 'assignment': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey,
        stage: `assignments.${spec.target}`, value: options.assignment?.(spec) ?? { policy: 'unknown', files: [] } }); break;
      case 'saver': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'materials', value: { files: [], links: [] } }); break;
      case 'ed': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'ed', value: { lessons: [] } }); break;
      case 'classify': await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'classification',
        value: options.classification?.(spec) ?? { items: [] } }); break;
    }
    yield { type: 'tool_step', tool: `coursework.${spec.kind}`, outcome: 'ok' };
    yield { type: 'result', turns: 1 };
  };
}

interface SetupOptions extends BehaviourOptions {
  extension?: ExtensionReader;
  script?: Script;
  prompt?: SyncPipeline['prompt'];
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
    { name: 'canvas.capture', description: 'Capture a Canvas page', inputSchema: {}, execute: async input => jobs.capture(input as Parameters<SyncJobs['capture']>[0]) },
    { name: 'handbook.capture', description: 'Capture the Handbook', inputSchema: {}, execute: async input => jobs.handbook(input as Parameters<SyncJobs['handbook']>[0]) },
  ];
  const adapter = new PipelineAgent(options.script ?? scripted(options));
  const pipeline: SyncPipeline = {
    prompt: options.prompt ?? (spec => JSON.stringify(spec)),
    tools: () => tools,
    build: options.build ?? ((key: string) => ({ document: docFor(key), conflicts: [], complete: true, unknown: [], synthetic: {} })),
    ...(options.ed ? { ed: options.ed } : {}),
    ...(options.archive ? { archive: options.archive } : {}),
    ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
  };
  const sync = new AgentSync({ store, jobs, adapter: () => adapter, pipeline, extension: options.extension,
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
      expect.objectContaining({ kind: 'courses', via: 'extension', steps: 0, turns: 0, outcome: 'error' }),
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
    }, build: (key, stages) => { events.push(`build:${key}`); expect(stages.tabs).toBeDefined();
      return { document: docFor(key), conflicts: [], complete: true, unknown: [], synthetic: {} }; } });
    seed(f.store, keyA, keyB);
    await f.sync.run({});
    const kindsA = f.adapter.specs.filter(spec => spec.courseKey === keyA).map(spec => spec.kind);
    expect(kindsA).toEqual(['handbook', 'tabs', 'groups', 'main', 'quizzes', 'assignment', 'saver', 'classify']);
    const kindsB = f.adapter.specs.filter(spec => spec.courseKey === keyB).map(spec => spec.kind);
    expect(kindsB).toEqual(kindsA);
    expect(events.indexOf(`build:${keyA}`)).toBeGreaterThan(events.indexOf(`start:${keyA}:classify`));
    // Every job of the first course, including its import after classify, finishes before the second course starts.
    expect(events.indexOf(`start:${keyB}:handbook`)).toBeGreaterThan(events.indexOf(`build:${keyA}`));
    expect(f.adapter.specs.findIndex(spec => spec.courseKey === keyB))
      .toBeGreaterThan(f.adapter.specs.findLastIndex(spec => spec.courseKey === keyA));
  });

  it('Classify: prompt context carries the groups and skeleton stages written earlier in the same course', async () => {
    const seen: { spec: JobSpec; ctx?: PipelineJobContext }[] = [];
    const f = setup({ prompt: (spec, ctx) => { seen.push({ spec, ctx }); return JSON.stringify(spec); } });
    seed(f.store, keyA);
    await f.sync.run({});
    const classify = seen.find(entry => entry.spec.kind === 'classify' && entry.spec.courseKey === keyA);
    expect(classify?.ctx?.stages.groups).toBeDefined();
    expect(classify?.ctx?.stages.skeleton).toBeDefined();
  });

  it('Handbook unavailable: two failed handbook jobs do not stop the course, and the build sees no skeleton', async () => {
    let stagesSeen: Record<string, unknown> | undefined;
    const f = setup({ behaviour: spec => spec.kind === 'handbook' ? 'unavailable' : 'ok',
      build: (key, stages) => { stagesSeen = stages; return { document: docFor(key), conflicts: [], complete: true, unknown: [], synthetic: {} }; } });
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

  it('Main gets only the normalised home URL: a grades URL or a deeper path never reaches a job', async () => {
    const gradesPage = `${canvasA}/grades`;
    const trailing = `${canvasB}/`;
    const deeper = `${canvasA}/assignments`;
    const f = setup();
    f.store.saveCourseSelections([
      selection(keyA, { canvas: gradesPage }),
      selection(keyB, { canvas: trailing }),
      selection('SYNC30003:2026:S2', { canvas: deeper }),
    ]);
    await f.sync.run({});
    const urls = f.adapter.specs.flatMap(spec => spec.urls);
    for (const raw of [gradesPage, trailing, deeper]) expect(urls).not.toContain(raw);
    expect(f.adapter.specs.filter(spec => spec.kind === 'main').map(spec => ({ key: spec.courseKey, urls: spec.urls })))
      .toEqual([{ key: keyB, urls: [canvasB] }]);
  });

  it('An assignment job never gets the grades tab URL or another course assignment', async () => {
    const gradesUrl = `${canvasA}/grades`;
    const otherCourse = `${canvasB}/assignments/9`;
    const f = setup({ groups: spec => {
      const stage = groupsFor(spec.courseKey!);
      const group = stage.groups[0]!;
      return { ...stage, groups: [{ ...group, assignments: [
        group.assignments[0]!,
        { ...group.assignments[0]!, id: '2', htmlUrl: gradesUrl },
        { ...group.assignments[0]!, id: '3', htmlUrl: otherCourse },
      ] }] };
    } });
    seed(f.store, keyA);
    await f.sync.run({});
    const urls = f.adapter.specs.flatMap(spec => spec.urls);
    expect(urls).not.toContain(gradesUrl);
    expect(urls).not.toContain(otherCourse);
    expect(f.adapter.specs.filter(spec => spec.kind === 'assignment').map(spec => spec.urls[0]))
      .toEqual([`${canvasA}/assignments/1`]);
  });

  it('An assignment job never gets a link-only tab URL such as Lecture Capture', async () => {
    const lectures = `${canvasA}/external_tools/77`;
    const f = setup({
      tabs: spec => tabsFor(spec.courseKey!, [tab('context_external_tool_77', 'Lecture Capture', lectures)]),
      groups: spec => {
        const stage = groupsFor(spec.courseKey!);
        const group = stage.groups[0]!;
        return { ...stage, groups: [{ ...group, assignments: [group.assignments[0]!, { ...group.assignments[0]!, id: '2', htmlUrl: lectures }] }] };
      },
    });
    seed(f.store, keyA);
    await f.sync.run({});
    expect(f.adapter.specs.filter(spec => spec.kind === 'assignment').map(spec => spec.urls[0])).toEqual([`${canvasA}/assignments/1`]);
  });

  it('A run with more than 500 job attempts still closes, keeping at most 500 job records', async () => {
    const f = setup({
      behaviour: spec => spec.kind === 'assignment' ? 'error' : 'ok',
      groups: spec => {
        const stage = groupsFor(spec.courseKey!);
        const group = stage.groups[0]!;
        const assignments = Array.from({ length: 260 }, (_, index) => ({ ...group.assignments[0]!, id: String(index + 1),
          htmlUrl: `${canvasA}/assignments/${index + 1}` }));
        return { ...stage, groups: [{ ...group, assignments }] };
      },
    });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.run.jobs).toHaveLength(500);
    expect(f.sync.status().running).toBe(false);
    expect(f.store.loadRun(result.run.id)?.jobs).toHaveLength(500);
  });

  it('Without a Canvas course id, an assignment URL from another course is refused', async () => {
    const otherCourse = `${canvasB}/assignments/9`;
    const base = scripted();
    const f = setup({ script: async function* (spec, call) {
      if (spec.kind === 'handbook') {
        const stage = groupsFor(keyB);
        const group = stage.groups[0]!;
        await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'groups',
          value: { ...stage, groups: [{ ...group, assignments: [{ ...group.assignments[0]!, htmlUrl: otherCourse }] }] } });
      }
      yield* base(spec, call);
    } });
    f.store.saveCourseSelections([selection(keyA, { canvas: `${canvasA}/grades` })]);
    await f.sync.run({});
    expect(f.adapter.specs.filter(spec => spec.kind === 'assignment')).toEqual([]);
    expect(f.adapter.specs.flatMap(spec => spec.urls)).not.toContain(otherCourse);
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

  it('A failed extension course list does not stop previously selected courses', async () => {
    const f = setup();
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    expect(result.run.jobs?.filter(job => job.kind === 'courses').map(job => job.outcome)).toEqual(['error']);
    expect(result.run.courseCoverage?.[0]?.stored).toBe(true);
  });

  it('A build failure for one course keeps its old data and the run continues with the next course', async () => {
    let failA = false;
    const f = setup({ build: (key, stages) => {
      expect(stages.tabs).toBeDefined();
      if (failA && key === keyA) throw new Error('Synthetic build failure');
      return { document: docFor(key), conflicts: [], complete: true, unknown: [], synthetic: {} };
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

  it('Ed: no hook or a hook that stores nothing runs one fallback Ed job when the course has an Ed page', async () => {
    const withJob = setup();
    withJob.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
    const result = await withJob.sync.run({});
    const edS = withJob.adapter.specs.find(spec => spec.kind === 'ed');
    expect(edS?.urls).toEqual([edA]);
    // No CLI reader is wired, so the fallback job runs and the run notes that the CLI was not used.
    expect(withJob.jobs.load(result.run.id)?.stages?.[keyA]?.edCli).toEqual({ cli: 'not-used' });

    let hookCalls = 0;
    const withHook = setup({ ed: () => { hookCalls++; } });
    withHook.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
    await withHook.sync.run({});
    expect(hookCalls).toBe(1);
    // The hook stored no ed stage, so the one fallback job still runs.
    expect(withHook.adapter.specs.filter(spec => spec.kind === 'ed')).toHaveLength(1);
  });

  it('Ed: CLI unavailable (missing, signed out or non-zero) runs one fallback Ed job and notes the CLI was not used', async () => {
    const replies: { label: string; runner: EdRunner }[] = [
      { label: 'missing', runner: async () => { throw new Error('ENOENT edstem'); } },
      { label: 'signed out', runner: async args => args[0] === '--version' ? ok('0.8.2') : ok('{"authenticated":false}') },
      { label: 'auth exits non-zero', runner: async args => args[0] === '--version' ? ok('0.8.2') : { code: 1, stdout: '{"authenticated":true}' } },
    ];
    for (const { runner } of replies) {
      let f!: ReturnType<typeof setup>;
      f = setup({ ed: (key, ctx) => edHook(runner, f.jobs)(key, ctx) });
      f.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
      const result = await f.sync.run({});
      expect(f.adapter.specs.filter(spec => spec.kind === 'ed')).toHaveLength(1);
      expect(f.jobs.load(result.run.id)?.stages?.[keyA]?.edCli).toEqual({ cli: 'not-used' });
      expect(f.jobs.load(result.run.id)?.stages?.[keyA]?.ed).toBeDefined();
    }
  });

  it('Ed: the "CLI not used" note alone does not count as a stage, so a course whose jobs all failed keeps its stored data', async () => {
    let builds = 0;
    const runner: EdRunner = async () => { throw new Error('ENOENT edstem'); };
    let f!: ReturnType<typeof setup>;
    f = setup({ ed: (key, ctx) => edHook(runner, f.jobs)(key, ctx),
      behaviour: () => 'error',
      build: key => { builds++; return { document: docFor(key), conflicts: [], complete: true, unknown: [], synthetic: {} }; } });
    f.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
    const result = await f.sync.run({});
    expect(f.jobs.load(result.run.id)?.stages?.[keyA]?.edCli).toEqual({ cli: 'not-used' });
    expect(builds).toBe(0);
    expect(result.run.courseCoverage?.[0]?.stored).toBe(false);
  });

  it('Ed: CLI available stores the unit lessons as the ed stage and runs no Ed job', async () => {
    const calls: string[][] = [];
    const runner: EdRunner = async args => {
      calls.push(args);
      if (args[0] === '--version') return ok('0.8.2');
      if (args[0] === 'auth') return ok('{"authenticated":true,"region":"au"}');
      if (args[0] === 'units') return ok(JSON.stringify([{ id: 4101, code: 'SYNA10001 S2 2026', name: 'Synthetic Systems',
        year: '2026', session: 'Semester 2', status: 'current', role: 'student' }]));
      if (args[0] === 'lessons') return ok(JSON.stringify([{ id: 7001, courseId: 8001, moduleId: 11, title: 'Synthetic lesson',
        moduleName: 'Synthetic module', type: 'lesson', kind: 'lesson', state: 'published', status: 'open', slideCount: 1,
        openable: true, openableWithoutAttempt: true, dueAt: '2026-03-01T23:59:00+11:00' }]));
      if (args[0] === 'files') return ok('[]');
      return { code: 1, stdout: '' };
    };
    let f!: ReturnType<typeof setup>;
    f = setup({ ed: (key, ctx) => edHook(runner, f.jobs)(key, ctx) });
    f.store.saveCourseSelections([selection(keyA, { canvas: canvasA, ed: edA })]);
    const result = await f.sync.run({});
    expect(f.adapter.specs.some(spec => spec.kind === 'ed')).toBe(false);
    expect(f.jobs.load(result.run.id)?.stages?.[keyA]?.ed).toMatchObject({ via: 'api', source: 'edstem-cli', unitId: 4101,
      lessons: [{ id: '7001', title: 'Synthetic lesson', module: 'Synthetic module', dueAt: '2026-03-01T23:59:00+11:00',
        url: 'https://edstem.org/au/courses/8001/lessons/7001' }] });
    expect(f.jobs.load(result.run.id)?.stages?.[keyA]?.edCli).toBeUndefined();
    expect(calls.some(args => args[0] === 'lessons' && args[1] === 'mark-read')).toBe(false);
    expect(calls.every(args => !args.includes('--yes'))).toBe(true);
  });

  it('Built document imported: the pipeline builds and stores one document without an agent import call', async () => {
    const f = setup({
      build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]),
      groups: () => groupsWith(30),
      classification: () => classifyAs([{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
      map: () => ({ links: [], aiPolicy: { value: 'allowed', quote: 'Generative AI is permitted for this course.' } }),
    });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    const course = f.store.query('courses', { limit: 10 }).items[0] as { id: string; aiPolicy?: string };
    expect(course).toMatchObject({ code: 'SYNA10001', aiPolicy: 'allowed' });
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))).toMatchObject({
      kind: 'assignment', weight: 30, group: { key: 'SYNA10001:assignments' },
    });
    expect(f.jobs.load(result.run.id)?.results?.[keyA]).toMatchObject({ courseId: course.id, components: 1, items: 1 });
  });

  it('Owner keeps the Handbook weight end to end: the skeleton choice is applied and the conflict stays resolved', async () => {
    const f = setup({
      build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]),
      groups: () => groupsWith(40),
      classification: () => classifyAs([{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
    });
    seed(f.store, keyA);
    await f.sync.run({});
    const courseId = f.sync.status().courses.find(course => course.key === keyA)!.courseId!;
    const open = f.store.listSyncConflicts(courseId).find(conflict => conflict.field === 'weight')!;
    expect(open).toMatchObject({ state: 'open', skeletonValue: 30, canvasValue: 40 });
    const id = assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1');
    expect(f.store.loadAssessment(id)?.weight).toBe(40);

    f.jobs.resolve({ conflictId: open.id, choice: 'skeleton' });
    const second = await f.sync.run({});
    expect(second.outcome).toBe('OK');
    expect(f.store.loadAssessment(id)).toMatchObject({ weight: 30, group: { weight: 30 } });
    expect(f.store.loadSyncConflict(open.id)).toMatchObject({ state: 'resolved', choice: 'skeleton' });
  });

  it('A later sync whose values agree closes the conflict; a partial groups stage does not', async () => {
    let weight = 40;
    const f = setup({
      build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]),
      groups: () => groupsWith(weight),
      classification: () => classifyAs([{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
    });
    seed(f.store, keyA);
    await f.sync.run({});
    const courseId = f.sync.status().courses.find(course => course.key === keyA)!.courseId!;
    const open = f.store.listSyncConflicts(courseId)[0]!;
    expect(open.state).toBe('open');
    weight = 30;
    await f.sync.run({});
    expect(f.store.loadSyncConflict(open.id)).toMatchObject({ state: 'agreed' });
    expect(f.store.listSyncConflicts(courseId)).toHaveLength(1);

    let partialWeight = 40;
    let coverage: 'api' | 'partial' = 'api';
    const partial = setup({
      build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]),
      groups: () => groupsWith(partialWeight, { coverage }),
      classification: () => classifyAs([{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
    });
    seed(partial.store, keyA);
    await partial.sync.run({});
    const partialCourseId = partial.sync.status().courses.find(course => course.key === keyA)!.courseId!;
    const stillOpen = partial.store.listSyncConflicts(partialCourseId)[0]!;
    partialWeight = 30;
    coverage = 'partial';
    await partial.sync.run({});
    expect(partial.store.loadSyncConflict(stillOpen.id)).toMatchObject({ state: 'open', canvasValue: 40 });
  });

  it('Classification retried once: the second classify job lists the missing id and its answer is stored', async () => {
    const base = scripted({ skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]), groups: () => groupsWith(30) });
    let classifications = 0;
    const f = setup({ build: realBuild, script: async function* (spec, call) {
      if (spec.kind === 'classify') {
        classifications++;
        await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'classification',
          value: classifyAs(classifications > 1 ? [{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }] : []) });
        yield { type: 'tool_step', tool: 'coursework.items.classify', outcome: 'ok' };
        yield { type: 'result', turns: 1 };
        return;
      }
      yield* base(spec, call);
    } });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    const classifySpecs = f.adapter.specs.filter(spec => spec.kind === 'classify');
    expect(classifySpecs).toHaveLength(2);
    expect(classifySpecs[1]!.retry).toEqual(['1']);
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))).toMatchObject({
      kind: 'assignment', group: { key: 'SYNA10001:assignments' },
    });
  });

  it('Classification retry merges by id: first-round answers survive when the retry returns only re-checked items', async () => {
    const groups = groupsWith(30);
    const group = groups.groups[0]!;
    const twoItems: GroupsStage = { ...groups, groups: [{ ...group, assignments: [
      group.assignments[0]!,
      { ...group.assignments[0]!, id: '2', name: 'Synthetic item 2', htmlUrl: `${canvasA}/assignments/2` },
    ] }] };
    const base = scripted({ skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]), groups: () => twoItems });
    let classifications = 0;
    const f = setup({ build: realBuild, script: async function* (spec, call) {
      if (spec.kind === 'classify') {
        classifications++;
        // The first round also names item 2, but says `ungraded`; the retry names only the re-checked id.
        const items = classifications > 1
          ? [{ id: '2', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]
          : [
            { id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' },
            { id: '2', category: 'ungraded', component: 'Assignments', evidence: 'Synthetic group name' },
          ];
        await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'classification', value: classifyAs(items) });
        yield { type: 'tool_step', tool: 'coursework.items.classify', outcome: 'ok' };
        yield { type: 'result', turns: 1 };
        return;
      }
      yield* base(spec, call);
    } });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    const stage = f.jobs.load(f.adapter.specs[0]!.jobId)?.stages?.[keyA]?.classification as { items: { id: string; category: string }[] };
    expect(stage.items).toEqual([
      expect.objectContaining({ id: '1', category: 'assignment' }),
      expect.objectContaining({ id: '2', category: 'assignment' }),
    ]);
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1')))
      .toMatchObject({ kind: 'assignment', group: { key: 'SYNA10001:assignments' } });
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:2')))
      .toMatchObject({ kind: 'assignment', group: { key: 'SYNA10001:assignments' } });
  });

  it('Classification still missing after the retry is stored unknown and counted in the run', async () => {
    const base = scripted({ skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]), groups: () => groupsWith(30) });
    const f = setup({ build: realBuild, script: async function* (spec, call) {
      if (spec.kind === 'classify') {
        await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'classification', value: classifyAs([]) });
        yield { type: 'tool_step', tool: 'coursework.items.classify', outcome: 'ok' };
        yield { type: 'result', turns: 1 };
        return;
      }
      yield* base(spec, call);
    } });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(f.adapter.specs.filter(spec => spec.kind === 'classify')).toHaveLength(2);
    // `components[1].items[0].due` is synthetic; the item's unknown kind is the classification failure to count.
    const unknownFields = f.jobs.load(result.run.id)?.results?.[keyA]?.unknownFields ?? [];
    expect(unknownFields).toEqual(['course.name', 'components[0].kind', 'components[1].kind',
      'components[1].items[0].due', 'components[1].items[0].kind']);
    expect(result.run.courseCoverage?.[0]?.unknownFields).toBe(5);
    const item = f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))!;
    expect(item.kind).toBeUndefined();
    expect(item.readState?.kind?.state).toBe('unknown');
    expect(item.group?.key).toBe('SYNA10001:unassigned');
  });

  it('Course aiPolicy from course.map reaches the Course with its quote; absent means unknown', async () => {
    const f = setup({ build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]), groups: () => groupsWith(30),
      map: () => ({ links: [], aiPolicy: { value: 'prohibited', quote: 'No generative AI may be used in this course.' } }) });
    seed(f.store, keyA);
    await f.sync.run({});
    const course = f.store.query('courses', { limit: 10 }).items[0] as { id: string };
    expect(f.store.loadCourse(course.id)).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', quote: 'No generative AI may be used in this course.' } } });

    const missing = setup({ build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]), groups: () => groupsWith(30), map: () => ({ links: [] }) });
    seed(missing.store, keyA);
    await missing.sync.run({});
    const other = missing.store.query('courses', { limit: 10 }).items[0] as { id: string };
    expect(missing.store.loadCourse(other.id)?.aiPolicy).toBeUndefined();
    expect(missing.store.loadCourse(other.id)?.readState?.aiPolicy?.state).toBe('unknown');
  });

  it('Old API data is reused-style skip: an unchanged assignment is not given a job and its stored policy reaches the build', async () => {
    let assignmentJobs = 0;
    const f = setup({ build: realBuild,
      skeleton: () => skeletonFor([{ name: 'Assignments', weight: 30 }]),
      groups: () => groupsWith(30, { updatedAt: '2026-10-20T08:00:00Z' }),
      classification: () => classifyAs([{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
      assignment: () => {
        assignmentJobs++;
        return { policy: { value: assignmentJobs === 1 ? 'allowed' : 'prohibited',
          quote: assignmentJobs === 1 ? 'Generative AI is allowed here.' : 'Generative AI is prohibited here.' }, files: [] };
      } });
    seed(f.store, keyA);
    await f.sync.run({});
    expect(assignmentJobs).toBe(1);
    const id = assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1');
    expect(f.store.loadAssessment(id)).toMatchObject({ aiPolicy: 'allowed',
      readState: { aiPolicy: { quote: 'Generative AI is allowed here.' } } });

    const before = f.adapter.specs.length;
    const second = await f.sync.run({});
    const newSpecs = f.adapter.specs.slice(before);
    expect(second.outcome).toBe('OK');
    expect(newSpecs.filter(spec => spec.kind === 'assignment')).toEqual([]);
    expect(assignmentJobs).toBe(1);
    expect(f.store.loadAssessment(id)).toMatchObject({ aiPolicy: 'allowed',
      readState: { aiPolicy: { quote: 'Generative AI is allowed here.' } } });
  });

});

describe('extension course list (extension-course-list)', () => {
  const url = canvasApiUrl('courses');
  const text = JSON.stringify([{ id: 900001, course_code: 'SYNA10001', name: 'Synthetic Systems', term: { name: 'Semester 2 2026' } }]);
  it('captures unchanged courses, preserves selection and starts no courses agent', async () => {
    const f = setup({ extension: { read: async requested => {
      expect(requested).toBe(url); return { status: 200, finalUrl: url, text };
    } } });
    seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('OK');
    expect(f.jobs.candidates()).toMatchObject([{ key: keyA, selected: true }]);
    expect(f.adapter.specs.some(spec => spec.kind === 'courses')).toBe(false);
    expect(f.adapter.specs.map(spec => spec.kind)).toEqual(expect.arrayContaining(['tabs', 'groups']));
    expect(f.store.loadRun(result.run.id)?.jobs?.filter(job => job.kind === 'courses')).toEqual([
      expect.objectContaining({ via: 'extension', ms: expect.any(Number), outcome: 'ok' }),
    ]);
  });
  it.each([
    { status: 200, finalUrl: 'https://canvas.lms.unimelb.edu.au/login/saml', text },
    { status: 401, finalUrl: url, text },
  ])('marks signed-out discovery unavailable and stores no candidates (%j)', async response => {
    const f = setup({ extension: { read: async () => response } });
    const result = await f.sync.run({});
    expect(result.outcome).toBe('AGENT_UNAVAILABLE');
    expect(f.jobs.candidates()).toEqual([]);
    expect(f.adapter.specs).toEqual([]);
    expect(result.run.jobs).toEqual([expect.objectContaining({ via: 'extension', outcome: 'error', reason: 'signed out', ms: expect.any(Number) })]);
  });
  it('marks malformed Canvas text unavailable without storing candidates', async () => {
    const f = setup({ extension: { read: async () => ({ status: 200, finalUrl: url, text: 'not JSON' }) } });
    const result = await f.sync.run({});
    expect(result.outcome).toBe('AGENT_UNAVAILABLE');
    expect(f.jobs.candidates()).toEqual([]);
    expect(result.run.jobs?.[0]).toMatchObject({ via: 'extension', outcome: 'error', reason: expect.any(String) });
  });
  it('continues saved courses immediately when disconnected', async () => {
    const f = setup(); seed(f.store, keyA);
    const result = await f.sync.run({});
    expect(result.run.courseCoverage?.[0]?.stored).toBe(true);
    expect(result.run.jobs?.[0]).toMatchObject({ via: 'extension', outcome: 'error', reason: 'extension disconnected' });
    expect(f.adapter.specs.some(spec => spec.kind === 'courses')).toBe(false);
    expect(result.run.jobs?.[0]?.ms).toBeLessThan(1_000);
  });
});
