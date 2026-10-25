import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun, AgentTool } from '../../src/agent/adapter.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { AgentSync } from '../../src/sync/agent-job.js';
import { SyncJobs } from '../../src/sync/jobs.js';
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
function setup(script: Script, options: { timeoutMs?: number } = {}) {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'agent-job-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const tools: AgentTool[] = agent.registry.list().map(entry => ({ name: entry.name, description: entry.name, inputSchema: {},
    execute: input => dispatch(agent.registry, entry.name, input, agent.context) }));
  const adapter = new ScriptedAgent(script);
  const sync = new AgentSync({ store, jobs: new SyncJobs(store), adapter: () => adapter, tools: () => tools, ...options });
  const select = (...keys: string[]) => dispatch(host.registry, 'courses.select', { selections: keys.map(key => ({ key, selected: true })) }, host.context);
  return { store, sync, adapter, select };
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
    expect(f.adapter.inputs[0]!.prompt).toMatch(/Edge itself cannot be reached[^\n]*locked[^\n]*both platforms in `blocked`/);
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
    const f = setup(async function* () { await new Promise(() => {}); yield { type: 'result', turns: 1 }; }, { timeoutMs: 30 });
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
