import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentInput, AgentRun } from '../../src/agent/adapter.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { document } from '../sync/course-document.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const key = 'SYNA10001:2026:S2';
/** Runs each production pipeline job through its real tools: courses.offer, handbook.capture and items.classify. */
class ReadingAgent implements AgentAdapter {
  readonly id = 'synthetic'; readonly inputs: AgentInput[] = [];
  constructor(private readonly clipboard: { text: string; read(): string }) {}
  start(input: AgentInput): AgentRun {
    this.inputs.push(input);
    const jobId = /Job id: (\S+)/.exec(input.prompt)![1]!;
    const clipboard = this.clipboard;
    const tool = (name: string) => input.tools.find(entry => entry.name === name);
    const call = async (name: string, args: unknown) => {
      const found = tool(name);
      if (!found) throw new Error(`missing synthetic tool ${name}`);
      return await found.execute(args) as { ok: boolean; error?: { message: string } };
    };
    return { async *[Symbol.asyncIterator]() {
      if (tool('courses.offer')) {
        const result = await call('courses.offer', { jobId, courses: [{ code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2', pages: {} }], blocked: [] });
        expect(result.ok).toBe(true);
      } else if (tool('handbook.capture')) {
        clipboard.text = ['The University of Melbourne Handbook', 'SYNA10001 Synthetic Systems', 'Assessment',
          'Description\tTiming\tPercentage', 'Assignments\tWeeks 3-10\t100%'].join('\n');
        const result = await call('handbook.capture', { jobId, courseKey: key });
        expect(result.ok).toBe(true);
      } else if (tool('items.classify')) {
        const result = await call('items.classify', { jobId, courseKey: key, items: [] });
        expect(result.ok).toBe(true);
      }
      yield { type: 'tool_step', tool: 'coursework.synthetic', outcome: 'ok' };
      yield { type: 'result', turns: 2 };
    }, interrupt() {} };
  }
}
function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sync-protocol-')));
  const clipboard = { text: '', read(): string { return clipboard.text; } };
  const adapter = new ReadingAgent(clipboard);
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), agentAdapter: adapter, clipboard, edRunner: async () => ({ code: 1, stdout: '' }), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
  return { store, host, adapter };
}

it('sync.run is owner-only; coursework sync --course runs the agent job and sync.status reads its outcome from the store', async () => {
  const { host, adapter, store } = setup();
  const { owner: _owner, ...anonymous } = host.context;
  expect(await dispatch(host.registry, 'sync.run', {}, anonymous)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  const agent = host.registry.agentTools(host.context);
  expect(await dispatch(agent.registry, 'sync.run', {}, agent.context)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(adapter.inputs).toHaveLength(0);
  const stdout = vi.fn();
  await parseProtocolCLI(['sync', '--course', 'SYNA10001', '--json'], { registry: host.registry, context: host.context, isTTY: true, stdout, stderr: vi.fn() });
  expect(stdout).toHaveBeenCalledTimes(1);
  const result = JSON.parse(stdout.mock.calls[0]![0]);
  expect(result).toMatchObject({ protocol: 'coursework.agent/v1', command: 'sync.run', ok: true, data: { outcome: 'OK', run: { command: 'sync', syncOutcome: 'OK' } } });
  expect(adapter.inputs.some(input => input.prompt.includes(key))).toBe(true);
  expect(store.query('courses', { limit: 10 }).items).toEqual([expect.objectContaining({ code: 'SYNA10001' })]);
  expect(await dispatch(host.registry, 'sync.status', {}, anonymous)).toMatchObject({ ok: true, data: { running: false, blocked: [], undecided: 0,
    lastRun: { id: result.data.run.id, outcome: 'OK' }, courses: [{ key, storedAt: expect.any(String) }] } });
});

it('production mounts an injected sync service for every transport', async () => {
  const store = new SqliteRepository(':memory:');
  cleanups.push(() => store.close());
  const status = { running: false, blocked: [], undecided: 0, courses: [] };
  const sync = { run: vi.fn(), status: vi.fn(() => status) };
  const host = createProductionProtocol({ store, sync });
  expect(host.registry.get('sync.run')).toBeDefined();
  expect(await host.registry.get('sync.status')!.handler({}, host.context)).toEqual(status);
});
