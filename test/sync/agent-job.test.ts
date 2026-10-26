import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun, AgentTool } from '../../src/agent/adapter.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { AgentJobRunner, AgentSync, JOB_BOUND_MS, runBoundMs } from '../../src/sync/agent-job.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { AgentFacingError } from '../../src/protocol/errors.js';
import { assessmentId } from '../../src/sync/course-import.js';
import { component, document, found, item, quoted } from './course-document.js';

type Call = (name: string, input: unknown) => Promise<Record<string, any>>;
type Script = (call: Call, jobId: string, input: AgentInput) => AsyncGenerator<AgentEvent, void>;
/** Synthetic agent: runs a script that calls our tools through the registry, as Codex does through `coursework mcp`. */
class ScriptedAgent implements AgentAdapter {
  readonly id = 'synthetic';
  readonly inputs: AgentInput[] = [];
  interrupted = 0;
  constructor(private readonly script: Script) {}
  start(input: AgentInput): AgentRun {
    this.inputs.push(input);
    const jobId = /Job id: (\S+)/.exec(input.prompt)![1]!;
    const call: Call = async (name, args) => {
      const tool = input.tools.find(entry => entry.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return await tool.execute(args) as Record<string, any>;
    };
    const self = this;
    return { [Symbol.asyncIterator]: () => self.script(call, jobId, input), interrupt() { self.interrupted++; } };
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const pages = { canvas: 'https://canvas.lms.unimelb.edu.au/courses/900001', ed: 'https://edstem.org/au/courses/800001' };
const three = [{ code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2', pages }, { code: 'SYNB20002', term: '2026:S2', pages: {} }, { code: 'SYNC30003', term: '2026:S2', pages: {} }];
function setup(script: Script, options: { runBoundMs?: number; jobBoundMs?: number } = {}) {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agent-job-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const tools: AgentTool[] = agent.registry.list().map(entry => ({ name: entry.name, description: entry.name, inputSchema: {},
    execute: input => dispatch(agent.registry, entry.name, input, agent.context) }));
  const adapter = new ScriptedAgent(script);
  const jobs = new SyncJobs(store);
  const sync = new AgentSync({ store, jobs, adapter: () => adapter, tools: () => tools, ...options });
  const select = (...keys: string[]) => dispatch(host.registry, 'courses.select', { selections: keys.map(key => ({ key, selected: true })) }, host.context);
  return { store, sync, jobs, adapter, select };
}
async function* offerOnly(call: Call, jobId: string): AsyncGenerator<AgentEvent, void> {
  expect(await call('courses.offer', { jobId, courses: three, blocked: [] })).toMatchObject({ ok: true });
  yield { type: 'tool_step', tool: 'coursework.courses.offer', outcome: 'ok' };
  yield { type: 'result', turns: 3 };
}
const graded = document([component('assignments', 60, [item(1), item(2, {}, 'SYNA10001', 'ed')], { count: found(2) }), component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })]);

describe('agent sync job (coursework-sync)', () => {
  it('First run: three offered courses become undecided candidates, nothing is read, and the run ends NEEDS_SELECTION', async () => {
    const f = setup(offerOnly);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('NEEDS_SELECTION');
    expect(f.store.listCourseSelections().map(row => [row.key, row.selected])).toEqual([['SYNA10001:2026:S2', undefined], ['SYNB20002:2026:S2', undefined], ['SYNC30003:2026:S2', undefined]]);
    expect(f.adapter.inputs[0]!.prompt).toContain('Selected courses: none');
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([]);
    expect(f.store.loadRun(result.run.id)).toMatchObject({ command: 'sync', syncOutcome: 'NEEDS_SELECTION', turns: 3, steps: 1, courseCoverage: [] });
    expect(f.sync.status()).toMatchObject({ running: false, undecided: 3, lastRun: { outcome: 'NEEDS_SELECTION' } });
  });

  it('Owner selects two courses: the next run asks the agent to read exactly those two, and --course limits it to one', async () => {
    const f = setup(offerOnly);
    await f.sync.run({});
    await f.select('SYNA10001:2026:S2', 'SYNC30003:2026:S2');
    await f.sync.run({});
    const prompt = f.adapter.inputs[1]!.prompt;
    expect(prompt).toContain('SYNA10001:2026:S2');
    expect(prompt).toContain('SYNC30003:2026:S2');
    expect(prompt).not.toContain('SYNB20002:2026:S2');
    expect(prompt).toContain(pages.canvas);
    await f.sync.run({ course: 'SYNC30003' });
    expect(f.adapter.inputs[2]!.prompt).toContain('SYNC30003:2026:S2');
    expect(f.adapter.inputs[2]!.prompt).not.toContain('SYNA10001:2026:S2');
    await expect(f.sync.run({ course: 'SYNB20002' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('the prompt carries the fixed reading rules, the job id, today and the course JSON Schema', async () => {
    const f = setup(offerOnly);
    await f.sync.run({});
    const prompt = f.adapter.inputs[0]!.prompt;
    for (const text of ['https://canvas.lms.unimelb.edu.au', 'https://edstem.org/au/dashboard', 'courses.offer', 'course.import', 'screenshot',
      'blocked', 'never type', 'at most 3', 'componentsComplete', '"hurdleMin"', 'today:']) expect(prompt.toLowerCase()).toContain(text.toLowerCase());
    expect(f.adapter.inputs[0]!.transcript).toEqual([]);
  });

  it('the prompt reads stated item weights with evidence and restricts points-to-percentage conversion', async () => {
    const f = setup(offerOnly);
    await f.sync.run({});
    const prompt = f.adapter.inputs[0]!.prompt;
    for (const rule of [
      'Read item-level weights from points in the item name or points column',
      'percentages in the syllabus or assignment-group header',
      'a breakdown inside a component',
      "(a) when a component's stated item points sum to its stated weight, or the course's stated item points sum to 100",
      "(b) otherwise, when a component's stated item points sum to 100, scale each item by the stated component weight",
      '(c) otherwise do not treat points as percentages and leave the weight unknown',
      'Record stated item weights as `found` with the exact page text as `quote` and the page URL as `source`',
      "Leave an item's `weight` unknown only when no page states it",
      'the tool splits the component weight evenly',
    ]) expect(prompt).toContain(rule);
  });

  it('Sync from the frontend: the run is visible as running and its outcome and coverage are recorded when it ends', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup(async function* (call, jobId) {
      await call('courses.offer', { jobId, courses: three.slice(0, 1), blocked: [] });
      yield { type: 'tool_step', tool: 'coursework.courses.offer', outcome: 'ok' };
      await gate;
      expect(await call('course.import', { jobId, document: graded })).toMatchObject({ ok: true });
      yield { type: 'tool_step', tool: 'coursework.course.import', outcome: 'ok' };
      yield { type: 'result', turns: 7 };
    });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const running = f.sync.run({});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.sync.status()).toMatchObject({ running: true, job: { id: expect.any(String) } });
    release();
    const result = await running;
    expect(result.outcome).toBe('OK');
    expect(result.run).toMatchObject({ outcome: 'ok', turns: 7, steps: 2, courseCoverage: [{ stored: true, submissions: 1, unknownFields: 0,
      platforms: { canvas: 'read', ed: 'read' }, policyChanged: false, courseRef: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(f.sync.status()).toMatchObject({ running: false, blocked: [], lastRun: { id: result.run.id, outcome: 'OK', turns: 7 },
      courses: [{ key: 'SYNA10001:2026:S2', storedAt: expect.any(String), courseId: expect.any(String), lastRun: { stored: true, unknownFields: [] } }] });
  });

  it('Second start: a start while a sync runs returns LOCKED and starts nothing', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup(async function* () { await gate; yield { type: 'result', turns: 1 }; });
    const first = f.sync.run({});
    await new Promise(resolve => setTimeout(resolve, 10));
    await expect(f.sync.run({})).rejects.toMatchObject({ code: 'LOCKED' });
    expect(f.adapter.inputs).toHaveLength(1);
    release(); await first;
    // Another process sees the same lock through the store.
    expect(f.store.listSyncJobs().filter(job => job.endedAt === undefined)).toEqual([]);
  });

  it('Expired sign-in is not hidden: Canvas blocked and Ed read give PARTIAL, Ed data updates, Canvas data stays and status lists Canvas', async () => {
    let round = 0;
    const f = setup(async function* (call, jobId) {
      round++;
      if (round === 1) await call('course.import', { jobId, document: graded });
      else {
        await call('courses.offer', { jobId, courses: [], blocked: ['canvas'] });
        const edOnly = document([component('assignments', 60, [item(2, { name: found('Renamed on Ed') }, 'SYNA10001', 'ed')], { count: found(2) }),
          component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })], { platforms: { canvas: 'blocked', ed: 'read' } });
        expect(await call('course.import', { jobId, document: edOnly })).toMatchObject({ ok: true });
      }
      yield { type: 'result', turns: 2 };
    });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    expect((await f.sync.run({})).outcome).toBe('OK');
    const result = await f.sync.run({});
    expect(result.outcome).toBe('PARTIAL');
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ platforms: { canvas: 'blocked', ed: 'read' } })]);
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:ed:assignment:2'))).toMatchObject({ name: 'Renamed on Ed' });
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))?.retired).toBeUndefined();
    expect(f.sync.status()).toMatchObject({ blocked: ['canvas'], lastRun: { outcome: 'PARTIAL' } });
  });

  it('only tool results count: a selected course the agent only talks about stays unread and the run is PARTIAL', async () => {
    const f = setup(async function* () { yield { type: 'text', text: 'I imported every course.' }; yield { type: 'result', turns: 1 }; });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.outcome).toBe('PARTIAL');
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ stored: false, submissions: 0, platforms: { canvas: 'unread', ed: 'unread' } })]);
  });

  it('a discovery with every platform blocked and no candidates ends AGENT_UNAVAILABLE, and the prompt says how to report it', async () => {
    const f = setup(async function* (call, jobId) {
      expect(await call('courses.offer', { jobId, courses: [], blocked: ['canvas', 'ed'] })).toMatchObject({ ok: true });
      yield { type: 'result', turns: 1 };
    });
    const result = await f.sync.run({});
    expect(result).toMatchObject({ outcome: 'AGENT_UNAVAILABLE', run: { syncOutcome: 'AGENT_UNAVAILABLE' } });
    expect(f.sync.status()).toMatchObject({ blocked: ['canvas', 'ed'], lastRun: { outcome: 'AGENT_UNAVAILABLE' } });
    expect(f.adapter.inputs[0]!.prompt).toMatch(/computer-use tool or the browser[^\n]*unavailable[^\n]*locked[^\n]*both platforms in `blocked`/);
    // A missing Chrome or in-app browser is not a reason to give up: the job runs in the owner's open Edge.
    expect(f.adapter.inputs[0]!.prompt).toMatch(/owner's Microsoft Edge[^\n]*Never open Chrome/);
  });

  it('records AGENT_UNAVAILABLE and keeps previously stored data, marked with its last stored time', async () => {
    let round = 0;
    const f = setup(async function* (call, jobId) {
      round++;
      if (round === 1) { await call('course.import', { jobId, document: graded }); yield { type: 'result', turns: 2 }; return; }
      yield { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.' };
    });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    await f.sync.run({});
    const storedAt = f.sync.status().courses[0]!.storedAt;
    const result = await f.sync.run({});
    expect(result).toMatchObject({ outcome: 'AGENT_UNAVAILABLE', run: { outcome: 'error', syncOutcome: 'AGENT_UNAVAILABLE' } });
    expect(f.store.query('assessments', { limit: 10 }).items.length).toBeGreaterThan(0);
    expect(f.sync.status().courses[0]).toMatchObject({ storedAt, lastRun: { stored: false } });
  });

  it('stops a run after its time bound and records TIMEOUT', async () => {
    const f = setup(async function* () { await new Promise(() => {}); yield { type: 'result', turns: 1 }; }, { runBoundMs: 30 });
    const result = await f.sync.run({});
    expect(result.outcome).toBe('TIMEOUT');
    expect(f.adapter.interrupted).toBe(1);
    expect(f.sync.status()).toMatchObject({ running: false, lastRun: { outcome: 'TIMEOUT' } });
  });

  it('reports the policy change, unknown fields and weight-sum warning of the last run in sync.status', async () => {
    const f = setup(async function* (call, jobId) {
      const doc = document([component('assignments', 50, [item(1, { due: { value: null, state: 'unknown', checkedAt: '2026-10-24T00:00:00Z' } })]),
        component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })], { aiPolicy: quoted('prohibited', 'No AI.') });
      for (let i = 0; i < 3; i++) await call('course.import', { jobId, document: doc });
      yield { type: 'result', turns: 4 };
    });
    f.store.saveCourseSelections([{ key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
    const result = await f.sync.run({});
    expect(result.run.courseCoverage).toEqual([expect.objectContaining({ submissions: 3, unknownFields: 1, policyChanged: true })]);
    expect(f.sync.status().courses[0]!.lastRun).toMatchObject({ unknownFields: ['components[0].items[0].due'], warnings: ['WEIGHT_SUM'], weightSum: 90, policyChanged: true });
  });
});

const stageKey = 'SYNA10001:2026:S2';
const stageSelection = { key: stageKey, code: 'SYNA10001', term: '2026:S2', pages, offeredAt: '2026-10-24T00:00:00Z', selected: true };

/** The agent writes a stage through a tool, as 5.3's commands will through `coursework mcp`. */
const stageTool = (jobs: SyncJobs): AgentTool => ({
  name: 'stage.write', description: 'Store one pipeline stage', inputSchema: {},
  execute: async input => {
    const { jobId, courseKey, stage, value } = input as { jobId: string; courseKey: string; stage: string; value: unknown };
    jobs.recordStage(jobId, courseKey, stage, value);
    return { ok: true };
  },
});

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
    const f = runnerSetup(async function* (call, jobId) {
      await call('stage.write', { jobId, courseKey: stageKey, stage: 'map', value: { links: [] } });
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
    const f = runnerSetup(async function* (call, jobId) {
      await call('stage.write', { jobId, courseKey: stageKey, stage: 'map', value: { links: [] } });
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
    const f = setup(offerOnly);
    const job = f.jobs.open([stageKey]);
    const receipt = f.jobs.storeBuilt(job.id, graded);
    expect(receipt).toMatchObject({ stored: true, key: stageKey, components: 2, items: 2 });
    const loaded = f.jobs.load(job.id)!;
    expect(loaded.submissions).toEqual({});
    expect(loaded.results?.[stageKey]).toMatchObject({ courseId: expect.any(String), components: 2, items: 2, storedAt: expect.any(String) });
    expect(f.store.query('assessments', { limit: 10 }).items.length).toBeGreaterThan(0);
  });

  it('uses the final validation, so a built document with an unread field is stored with that field unknown', () => {
    const f = setup(offerOnly);
    const job = f.jobs.open([stageKey]);
    const built = document([component('assignments', 60, [item(1, { due: { value: null, state: 'unknown', checkedAt: '2026-10-24T00:00:00Z' } })]),
      component('exam', 40, [], { kind: found('exam'), isFinal: found(true) })]);
    const receipt = f.jobs.storeBuilt(job.id, built);
    expect(receipt).toMatchObject({ stored: true, key: stageKey, unknownFields: ['components[0].items[0].due'] });
    expect(f.jobs.load(job.id)?.submissions).toEqual({});
  });

  it('refuses an invalid built document without an agent-facing error and stores nothing', () => {
    const f = setup(offerOnly);
    const job = f.jobs.open([stageKey]);
    let caught: unknown;
    try { f.jobs.storeBuilt(job.id, {}); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'INVALID_INPUT' });
    expect(caught).not.toBeInstanceOf(AgentFacingError);
    expect(f.jobs.load(job.id)?.results).toBeUndefined();
  });
});
