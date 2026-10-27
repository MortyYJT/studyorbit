import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun, AgentTool } from '../../src/agent/adapter.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { AgentJobRunner, AgentSync, JOB_BOUND_MS, runBoundMs, type JobSpec, type SyncPipeline } from '../../src/sync/agent-job.js';
import { prompt as jobPrompt } from '../../src/agent/jobs/index.js';
import type { BuildDocumentResult } from '../../src/sync/build-document.js';
import type { CourseDocument } from '../../src/sync/course-json.js';
import type { ExtensionReader } from '../../src/sync/extension-bridge.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { AgentFacingError } from '../../src/protocol/errors.js';
import { assessmentId } from '../../src/sync/course-import.js';
import { component, document, found, item, quoted } from './course-document.js';

type Call = (name: string, input: unknown) => Promise<Record<string, any>>;
type Script = (spec: JobSpec, call: Call, input: AgentInput) => AsyncGenerator<AgentEvent, void>;
/** Synthetic agent: the pipeline prompt's first line carries the JobSpec, as Codex sees the job facts. */
class ScriptedAgent implements AgentAdapter {
  readonly id = 'synthetic';
  readonly inputs: AgentInput[] = [];
  readonly specs: JobSpec[] = [];
  interrupted = 0;
  constructor(private readonly script: Script) {}
  start(input: AgentInput): AgentRun {
    this.inputs.push(input);
    const marked = /^JOB:(.*)$/m.exec(input.prompt);
    const spec = marked ? JSON.parse(marked[1]!) as JobSpec
      : { kind: 'main' as const, jobId: /Job id: (\S+)/.exec(input.prompt)![1]!, urls: [] };
    this.specs.push(spec);
    const call: Call = async (name, args) => {
      const tool = input.tools.find(entry => entry.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return await tool.execute(args) as Record<string, any>;
    };
    const self = this;
    return { [Symbol.asyncIterator]: () => self.script(spec, call, input), interrupt() { self.interrupted++; } };
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const pages = { canvas: 'https://canvas.lms.unimelb.edu.au/courses/900001', ed: 'https://edstem.org/au/courses/800001' };
const canvasOnly = { canvas: 'https://canvas.lms.unimelb.edu.au/courses/900001' };
const three = [{ code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2', pages }, { code: 'SYNB20002', term: '2026:S2', pages: {} }, { code: 'SYNC30003', term: '2026:S2', pages: {} }];
const docFor = (key: string): CourseDocument => {
  const code = key.slice(0, 9);
  const term = key.slice(10);
  return document([component('assignments', 60, [item(1, {}, code)], {}, code)], {}, code, term) as CourseDocument;
};
const built = (doc: CourseDocument, unknown: string[] = []): BuildDocumentResult =>
  ({ document: doc, conflicts: [], complete: true, unknown, synthetic: {} });

const stageTool = (jobs: SyncJobs): AgentTool => ({
  name: 'stage.write', description: 'Store one pipeline stage', inputSchema: {},
  execute: async input => {
    const { jobId, courseKey, stage, value } = input as { jobId: string; courseKey: string; stage: string; value: unknown };
    jobs.recordStage(jobId, courseKey, stage, value);
    return { ok: true };
  },
});
interface SetupOptions { extension?: ExtensionReader; runBoundMs?: number; jobBoundMs?: number; build?: SyncPipeline['build']; ed?: SyncPipeline['ed'] | false }
function setup(script: Script, options: SetupOptions = {}) {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agent-job-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const jobs = new SyncJobs(store);
  const tools: AgentTool[] = [stageTool(jobs)];
  const adapter = new ScriptedAgent(script);
  const ed = options.ed === false ? undefined : options.ed ?? (async (key, ctx) => {
    jobs.recordStage(ctx.jobId, key, 'ed', { via: 'ax', source: 'edstem-page', lessons: [] });
  });
  const pipeline: SyncPipeline = {
    prompt: (spec, ctx) => `JOB:${JSON.stringify(spec)}\n${jobPrompt(spec, ctx)}`,
    tools: () => tools,
    build: options.build ?? (key => built(docFor(key))),
    ...(ed ? { ed } : {}),
  };
  const sync = new AgentSync({ store, jobs, adapter: () => adapter, pipeline,
    extension: options.extension ?? { read: async url => ({ status: 200, finalUrl: url, text: JSON.stringify(three.map((course, i) => ({
      id: 900001 + i, course_code: course.code, name: course.name ?? 'Synthetic course', term: { name: 'Semester 2 2026' },
    }))) }) },
    ...(options.runBoundMs !== undefined ? { runBoundMs: options.runBoundMs } : {}),
    ...(options.jobBoundMs !== undefined ? { jobBoundMs: options.jobBoundMs } : {}) });
  const select = (...keys: string[]) => dispatch(host.registry, 'courses.select', { selections: keys.map(key => ({ key, selected: true })) }, host.context);
  return { store, sync, jobs, adapter, select, host };
}
/** Write the stage this job kind must produce, so the runner counts one successful attempt. */
async function writeStage(spec: JobSpec, call: Call): Promise<void> {
  const value = spec.kind === 'handbook' ? { source: 'synthetic', via: 'handbook', components: [] }
    : spec.kind === 'tabs' ? { source: 'synthetic', via: 'api', tabs: [] }
      : spec.kind === 'groups' ? { source: 'synthetic', via: 'api', coverage: 'api', unweighted: false, groups: [] }
        : spec.kind === 'main' ? { links: [] }
          : spec.kind === 'quizzes' ? { quizzes: [] }
            : spec.kind === 'assignment' ? { policy: { value: 'unknown' }, files: [] }
              : spec.kind === 'saver' ? { files: [], links: [] }
                : spec.kind === 'ed' ? { via: 'ax', source: 'edstem-page', lessons: [] }
                  : { items: [] };
  const stage = spec.kind === 'handbook' ? 'skeleton' : spec.kind === 'main' ? 'map' : spec.kind === 'saver' ? 'materials'
    : spec.kind === 'classify' ? 'classification' : spec.kind === 'assignment' ? `assignments.${spec.target}` : spec.kind;
  await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage, value });
}
/** Every agent job succeeds and writes its expected stage. */
function stageAll(spec: JobSpec, call: Call): AsyncGenerator<AgentEvent, void> {
  return (async function* () {
    await writeStage(spec, call);
    yield { type: 'tool_step', tool: `coursework.${spec.kind}`, outcome: 'ok' };
    yield { type: 'result', turns: 1 };
  })();
}
/** Every job succeeds and the archive hook records the synthetic counts production writes after a job. */
function archiveScript(counts: { missing: number; unresolved: number }, extra: Record<string, unknown> = {}): Script {
  return async function* (spec, call) {
    await writeStage(spec, call);
    if (spec.courseKey) await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'archive',
      value: { moved: 1, updated: 0, missing: counts.missing, unresolved: counts.unresolved, ...extra } });
    yield { type: 'tool_step', tool: `coursework.${spec.kind}`, outcome: 'ok' };
    yield { type: 'result', turns: 1 };
  };
}
const graded = document([component('assignments', 60, [item(1), item(2, {}, 'SYNA10001', 'ed')], { count: found(2) }), component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })]);

describe('agent sync job (coursework-sync)', () => {
  it('First run: three offered courses become undecided candidates, nothing is read, and the run ends NEEDS_SELECTION', async () => {
    const f = setup(stageAll);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('NEEDS_SELECTION');
    expect(f.store.listCourseSelections().map(row => [row.key, row.selected])).toEqual([['SYNA10001:2026:S2', undefined], ['SYNB20002:2026:S2', undefined], ['SYNC30003:2026:S2', undefined]]);
    expect(f.adapter.specs).toEqual([]);
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([]);
    expect(f.store.loadRun(result.run.id)).toMatchObject({ command: 'sync', syncOutcome: 'NEEDS_SELECTION', turns: 0, steps: 0, courseCoverage: [] });
    expect(f.sync.status()).toMatchObject({ running: false, undecided: 3, lastRun: { outcome: 'NEEDS_SELECTION' } });
  });

  it('Owner selects two courses: the next run reads exactly those two, and --course limits it to one', async () => {
    const f = setup(stageAll);
    await f.sync.run({});
    await f.select('SYNA10001:2026:S2', 'SYNC30003:2026:S2');
    const before = f.adapter.specs.length;
    await f.sync.run({});
    const second = f.adapter.specs.slice(before);
    expect(second.map(spec => spec.courseKey).filter(Boolean)).toEqual(expect.arrayContaining(['SYNA10001:2026:S2', 'SYNC30003:2026:S2']));
    expect(second.map(spec => spec.courseKey)).not.toContain('SYNB20002:2026:S2');
    expect(second.flatMap(spec => spec.urls)).toContain('https://canvas.lms.unimelb.edu.au/courses/900001');
    const beforeCourse = f.adapter.specs.length;
    await f.sync.run({ course: 'SYNC30003' });
    const limited = f.adapter.specs.slice(beforeCourse);
    const limitedKeys = limited.map(spec => spec.courseKey).filter(Boolean);
    expect(limitedKeys).toHaveLength(6);
    expect(new Set(limitedKeys)).toEqual(new Set(['SYNC30003:2026:S2']));
    await expect(f.sync.run({ course: 'SYNB20002' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('Sync from the frontend: the run is visible as running and its outcome and coverage are recorded when it ends', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup(async function* (spec, call) {
      if (spec.kind === 'handbook') await gate;
      await writeStage(spec, call);
      yield { type: 'tool_step', tool: `coursework.${spec.kind}`, outcome: 'ok' };
      yield { type: 'result', turns: 1 };
    });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const running = f.sync.run({});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.sync.status()).toMatchObject({ running: true, job: { id: expect.any(String) } });
    release();
    const result = await running;
    expect(result.outcome).toBe('OK');
    expect(result.run).toMatchObject({ outcome: 'ok', courseCoverage: [{ stored: true, submissions: 0, unknownFields: expect.any(Number),
      platforms: { canvas: 'read', ed: 'read' }, policyChanged: false, courseRef: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(result.run.turns).toBe(6);
    expect(result.run.steps).toBe(6);
    expect(f.sync.status()).toMatchObject({ running: false, blocked: [], lastRun: { id: result.run.id, outcome: 'OK', turns: 6 },
      courses: [{ key: 'SYNA10001:2026:S2', storedAt: expect.any(String), courseId: expect.any(String), lastRun: { stored: true, unknownFields: [] } }] });
  });

  it('copies the archive missing and unresolved counts into coverage and sync.status, without file names or paths', async () => {
    const f = setup(archiveScript({ missing: 2, unresolved: 1 },
      { names: ['synthetic-final-report.pdf'], paths: ['/synthetic/Downloads/synthetic-final-report.pdf'] }), { ed: false });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ missingFiles: 3 })]);
    expect(f.sync.status().courses[0]!.lastRun).toMatchObject({ missingFiles: 3 });
    expect(await dispatch(f.host.registry, 'sync.status', {}, f.host.context))
      .toMatchObject({ ok: true, data: { courses: [{ lastRun: { missingFiles: 3 } }] } });
    expect(JSON.stringify(result.run)).not.toContain('synthetic-final-report.pdf');
    expect(JSON.stringify(f.sync.status())).not.toContain('synthetic-final-report.pdf');
  });

  it('stores no missingFiles when the archive stage reports nothing missing', async () => {
    const f = setup(archiveScript({ missing: 0, unresolved: 0 }), { ed: false });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.run.courseCoverage?.[0]).not.toHaveProperty('missingFiles');
    expect(f.sync.status().courses[0]!.lastRun).not.toHaveProperty('missingFiles');
  });

  it('Second start: a start while a sync runs returns LOCKED and starts nothing', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup(async function* (spec, call) {
      if (spec.kind === 'handbook') await gate;
      await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'map', value: { links: [] } });
      yield { type: 'result', turns: 1 };
    });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const first = f.sync.run({});
    await new Promise(resolve => setTimeout(resolve, 10));
    await expect(f.sync.run({})).rejects.toMatchObject({ code: 'LOCKED' });
    expect(f.adapter.inputs).toHaveLength(1);
    release(); await first;
    expect(f.store.listSyncJobs().filter(job => job.endedAt === undefined)).toEqual([]);
  });

  it('Expired sign-in is not hidden: Canvas blocked and Ed read give PARTIAL, Ed data updates, Canvas data stays and status lists Canvas', async () => {
    let round = 0;
    const f = setup(async function* (spec, call) {
      await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'map', value: { links: [] } });
      yield { type: 'result', turns: 2 };
    }, { extension: { read: async url => ({ status: ++round === 1 ? 200 : 401, finalUrl: url, text: '[]' }) }, build: () => {
      if (round === 1) return built(graded as CourseDocument);
      const edOnly = document([component('assignments', 60, [item(2, { name: found('Renamed on Ed') }, 'SYNA10001', 'ed')], { count: found(2) }),
        component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })], { platforms: { canvas: 'blocked', ed: 'read' } });
      return built(edOnly as CourseDocument);
    } });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    expect((await f.sync.run({})).outcome).toBe('OK');
    const result = await f.sync.run({});
    expect(result.outcome).toBe('PARTIAL');
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ platforms: { canvas: 'blocked', ed: 'read' } })]);
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:ed:assignment:2'))).toMatchObject({ name: 'Renamed on Ed' });
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))?.retired).toBeUndefined();
    expect(f.sync.status()).toMatchObject({ blocked: ['canvas'], lastRun: { outcome: 'PARTIAL' } });
  });

  it('only tool results count: a selected course the agent only talks about stays unread and the run fails', async () => {
    const f = setup(async function* () { yield { type: 'text', text: 'I imported every course.' }; yield { type: 'result', turns: 1 }; }, { ed: false });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('FAILED');
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ stored: false, submissions: 0, platforms: { canvas: 'unread', ed: 'unread' } })]);
  });

  it('discovery without the extension ends AGENT_UNAVAILABLE without starting an agent', async () => {
    const f = setup(stageAll, { extension: { read: async () => { throw new Error('extension disconnected'); } } });
    const result = await f.sync.run({});
    expect(result.outcome).toBe('AGENT_UNAVAILABLE');
    expect(f.adapter.inputs).toEqual([]);
  });

  it('records AGENT_UNAVAILABLE and keeps previously stored data, marked with its last stored time', async () => {
    let round = 0;
    const f = setup(async function* (spec, call) {
      if (round === 1) {
        await call('stage.write', { jobId: spec.jobId, courseKey: spec.courseKey, stage: 'map', value: { links: [] } });
        yield { type: 'result', turns: 1 };
        return;
      }
      yield { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.' };
    }, { ed: false, extension: { read: async url => { round++; return { status: 200, finalUrl: url, text: '[]' }; } } });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    await f.sync.run({});
    const storedAt = f.sync.status().courses[0]!.storedAt;
    const result = await f.sync.run({});
    expect(result).toMatchObject({ outcome: 'AGENT_UNAVAILABLE', run: { outcome: 'error', syncOutcome: 'AGENT_UNAVAILABLE' } });
    expect(f.store.query('assessments', { limit: 10 }).items.length).toBeGreaterThan(0);
    expect(f.sync.status().courses[0]).toMatchObject({ storedAt, lastRun: { stored: false } });
  });

  it('stops a run after its time bound and records TIMEOUT', async () => {
    const f = setup(async function* () { await new Promise(() => {}); yield { type: 'result', turns: 1 }; }, { runBoundMs: 30 });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('TIMEOUT');
    expect(f.adapter.interrupted).toBe(1);
    expect(f.sync.status()).toMatchObject({ running: false, lastRun: { outcome: 'TIMEOUT' } });
  });

  it('reports the policy change, unknown fields and weight-sum warning of the last run in sync.status', async () => {
    const doc = document([component('assignments', 50, [item(1, { due: { value: null, state: 'unknown', checkedAt: '2026-10-24T00:00:00Z' } })]),
      component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })], { aiPolicy: quoted('prohibited', 'No AI.') });
    const f = setup(stageAll, { ed: false, build: () => built(doc as CourseDocument, ['components[0].items[0].due']) });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: canvasOnly, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ submissions: 0, policyChanged: true })]);
    expect(f.sync.status().courses[0]!.lastRun).toMatchObject({ unknownFields: expect.arrayContaining(['components[0].items[0].due']),
      warnings: expect.arrayContaining(['WEIGHT_SUM']), weightSum: 90, policyChanged: true });
  });
});

const stageKey = 'SYNA10001:2026:S2';
const stageSelection = { key: stageKey, code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true };

function runnerSetup(script: Script, options: { jobBoundMs?: number } = {}) {
  const f = setup(script, options);
  f.store.saveCourseSelections([stageSelection]);
  const job = f.jobs.open([stageKey]);
  const runner = new AgentJobRunner({ jobs: f.jobs, adapter: () => f.adapter, ...options });
  return { ...f, job, runner };
}

const oldJob = (store: SqliteRepository, id: string, courses: string[], minutes: number, now: Date): void => {
  store.saveSyncJob({ id, startedAt: new Date(now.getTime() - minutes * 60_000).toISOString(), courses, submissions: {} });
};

describe('agent job runner (layered-sync task 5.1)', () => {
  it('bounds each job at ten minutes and each run at twenty minutes per selected course, at least twenty', () => {
    expect(JOB_BOUND_MS).toBe(10 * 60_000);
    expect(runBoundMs(0)).toBe(20 * 60_000);
    expect(runBoundMs(1)).toBe(20 * 60_000);
    expect(runBoundMs(3)).toBe(60 * 60_000);
  });

  it('runs one adapter start, counts tool steps and turns, and succeeds when the expected stage is stored', async () => {
    const f = runnerSetup(async function* (spec, call) {
      await call('stage.write', { jobId: spec.jobId, courseKey: stageKey, stage: 'map', value: { links: [] } });
      yield { type: 'tool_step', tool: 'coursework.course.map', outcome: 'ok' };
      yield { type: 'tool_step', tool: 'coursework.course.map', outcome: 'ok' };
      yield { type: 'result', turns: 4 };
    });
    const result = await f.runner.run({ kind: 'main', jobId: f.job.id, courseKey: stageKey, prompt: `Job id: ${f.job.id}`,
      tools: [stageTool(f.jobs)], stage: 'map' });
    expect(result.outcome).toBe('ok');
    expect(result.attempts).toEqual([{ kind: 'main', courseKey: stageKey, steps: 2, turns: 4, outcome: 'ok' }]);
    expect(f.adapter.inputs).toHaveLength(1);
    expect(f.adapter.inputs[0]!.transcript).toEqual([]);
  });

  it('records the input and output tokens an attempt reports, on success and on failure', async () => {
    let attempt = 0;
    const f = runnerSetup(async function* (spec, call) {
      if (attempt++ === 0) { yield { type: 'error', code: 'INTERNAL', message: 'Synthetic failure', turns: 1, inputTokens: 50, outputTokens: 5 }; return; }
      await call('stage.write', { jobId: spec.jobId, courseKey: stageKey, stage: 'map', value: { links: [] } });
      yield { type: 'result', turns: 2, inputTokens: 900, outputTokens: 40 };
    });
    const result = await f.runner.run({ kind: 'main', jobId: f.job.id, courseKey: stageKey, prompt: `Job id: ${f.job.id}`,
      tools: [stageTool(f.jobs)], stage: 'map' });
    expect(result.attempts).toEqual([
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 1, outcome: 'error', inputTokens: 50, outputTokens: 5 },
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 2, outcome: 'ok', inputTokens: 900, outputTokens: 40 },
    ]);
  });

  it('fails a result that stored no expected stage, retries once and records both attempts', async () => {
    const f = runnerSetup(async function* () {
      yield { type: 'text', text: 'I stored the page.' };
      yield { type: 'result', turns: 3 };
    });
    const result = await f.runner.run({ kind: 'main', jobId: f.job.id, courseKey: stageKey, prompt: `Job id: ${f.job.id}`,
      tools: [], stage: 'map' });
    expect(result.outcome).toBe('error');
    expect(result.attempts).toEqual([
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 3, outcome: 'error' },
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 3, outcome: 'error' },
    ]);
    expect(f.adapter.inputs).toHaveLength(2);
  });

  it('interrupts a job at its own bound, records timeout on both attempts and ends instead of hanging', async () => {
    const f = runnerSetup(async function* () { await new Promise(() => {}); yield { type: 'result', turns: 1 }; }, { jobBoundMs: 20 });
    const result = await f.runner.run({ kind: 'main', jobId: f.job.id, courseKey: stageKey, prompt: `Job id: ${f.job.id}`,
      tools: [], stage: 'map' });
    expect(result.outcome).toBe('timeout');
    expect(result.attempts).toEqual([
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 0, outcome: 'timeout' },
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 0, outcome: 'timeout' },
    ]);
    expect(f.adapter.interrupted).toBe(2);
  });

  it('treats an adapter error event as a failed job even when the stage was stored, and retries once', async () => {
    const f = runnerSetup(async function* (spec, call) {
      await call('stage.write', { jobId: spec.jobId, courseKey: stageKey, stage: 'map', value: { links: [] } });
      yield { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Synthetic unavailable', turns: 2 };
    });
    const result = await f.runner.run({ kind: 'main', jobId: f.job.id, courseKey: stageKey, prompt: `Job id: ${f.job.id}`,
      tools: [stageTool(f.jobs)], stage: 'map' });
    expect(result.outcome).toBe('error');
    expect(result.attempts).toEqual([
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 2, outcome: 'error' },
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 2, outcome: 'error' },
    ]);
  });

  it('treats a thrown adapter as a failed job and retries it once', async () => {
    const f = runnerSetup(async function* () { throw new Error('Synthetic adapter failure'); });
    const result = await f.runner.run({ kind: 'main', jobId: f.job.id, courseKey: stageKey, prompt: `Job id: ${f.job.id}`,
      tools: [], stage: 'map' });
    expect(result.outcome).toBe('error');
    expect(result.attempts).toEqual([
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 0, outcome: 'error' },
      { kind: 'main', courseKey: stageKey, steps: 0, turns: 0, outcome: 'error' },
    ]);
  });
});

describe('sync job staleness and stage storage (layered-sync task 5.1)', () => {
  it('keeps a three-course job active at 30 minutes and ends a one-course job at 26', () => {
    const store = new SqliteRepository(':memory:');
    cleanups.push(() => store.close());
    const now = new Date('2026-10-26T12:00:00Z');
    const jobs = new SyncJobs(store, { now: () => now });
    oldJob(store, 'three-courses', [stageKey, 'SYNB20002:2026:S2', 'SYNC30003:2026:S2'], 30, now);
    oldJob(store, 'one-course', [stageKey], 26, now);
    expect(jobs.isActive(jobs.load('three-courses')!)).toBe(true);
    expect(jobs.isActive(jobs.load('one-course')!)).toBe(false);
  });

  it('refuses recordStage on an ended job and stores nothing', () => {
    const store = new SqliteRepository(':memory:');
    cleanups.push(() => store.close());
    const now = new Date('2026-10-26T12:00:00Z');
    const jobs = new SyncJobs(store, { now: () => now });
    oldJob(store, 'ended', [stageKey], 26, now);
    expect(() => jobs.recordStage('ended', stageKey, 'map', { links: [] })).toThrow(/No active sync job/);
    expect(jobs.load('ended')?.stages).toBeUndefined();
  });

  it('merges stages for an active job and refuses a course outside the job', () => {
    const store = new SqliteRepository(':memory:');
    cleanups.push(() => store.close());
    const jobs = new SyncJobs(store);
    const job = jobs.open([stageKey]);
    jobs.recordStage(job.id, stageKey, 'tabs', { tabs: [] });
    jobs.recordStage(job.id, stageKey, 'map', { links: [] });
    expect(jobs.load(job.id)?.stages).toEqual({ [stageKey]: { tabs: { tabs: [] }, map: { links: [] } } });
    expect(() => jobs.recordStage(job.id, 'SYNB20002:2026:S2', 'map', { links: [] })).toThrow(/not selected/);
    expect(jobs.load(job.id)?.stages).toEqual({ [stageKey]: { tabs: { tabs: [] }, map: { links: [] } } });
  });

  it('reads a stage written by a second SyncJobs instance on the same database file', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sync-stage-')));
    const path = join(directory, 'coursework.sqlite');
    const first = new SqliteRepository(path);
    const second = new SqliteRepository(path);
    cleanups.push(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
    const jobs = new SyncJobs(first);
    const other = new SyncJobs(second);
    const job = jobs.open([stageKey]);
    const map = { links: [{ label: 'Synthetic Files', url: `${pages.canvas}/files` }] };
    other.recordStage(job.id, stageKey, 'map', map);
    expect(jobs.load(job.id)?.stages?.[stageKey]?.map).toEqual(map);
  });
});

describe('built document import (layered-sync task 5.1)', () => {
  it('imports a built document without counting a submission and records its result', () => {
    const f = setup(stageAll);
    const job = f.jobs.open([stageKey]);
    const receipt = f.jobs.storeBuilt(job.id, graded);
    expect(receipt).toMatchObject({ stored: true, key: stageKey, components: 2, items: 2 });
    const loaded = f.jobs.load(job.id)!;
    expect(loaded.submissions).toEqual({});
    expect(loaded.results?.[stageKey]).toMatchObject({ courseId: expect.any(String), components: 2, items: 2, storedAt: expect.any(String) });
    expect(f.store.query('assessments', { limit: 10 }).items.length).toBeGreaterThan(0);
  });

  it('uses the final validation, so a built document with an unread field is stored with that field unknown', () => {
    const f = setup(stageAll);
    const job = f.jobs.open([stageKey]);
    const built = document([component('assignments', 60, [item(1, { due: { value: null, state: 'unknown', checkedAt: '2026-10-24T00:00:00Z' } })]),
      component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })]);
    const receipt = f.jobs.storeBuilt(job.id, built);
    expect(receipt).toMatchObject({ stored: true, key: stageKey, unknownFields: ['components[0].items[0].due'] });
    expect(f.jobs.load(job.id)?.submissions).toEqual({});
  });

  it('refuses an invalid built document without an agent-facing error and stores nothing', () => {
    const f = setup(stageAll);
    const job = f.jobs.open([stageKey]);
    let caught: unknown;
    try { f.jobs.storeBuilt(job.id, {}); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'INVALID_INPUT' });
    expect(caught).not.toBeInstanceOf(AgentFacingError);
    expect(f.jobs.load(job.id)?.results).toBeUndefined();
  });
});
