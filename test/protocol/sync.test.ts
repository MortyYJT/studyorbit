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
/** Reads the one selected course through course.import, as the agent does through `coursework mcp`. */
class ReadingAgent implements AgentAdapter {
  readonly id = 'synthetic'; readonly inputs: AgentInput[] = [];
  start(input: AgentInput): AgentRun {
    this.inputs.push(input);
    const jobId = /Job id: (\S+)/.exec(input.prompt)![1]!;
    return { async *[Symbol.asyncIterator]() {
      const result = await input.tools.find(tool => tool.name === 'course.import')!.execute({ jobId, document: document() }) as { ok: boolean };
      yield { type: 'tool_step', tool: 'coursework.course.import', outcome: result.ok ? 'ok' : 'error' };
      yield { type: 'result', turns: 2 };
    }, interrupt() {} };
  }
}
function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sync-protocol-')));
  const adapter = new ReadingAgent();
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), agentAdapter: adapter, owner: { assertOwner: async () => {} } });
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
  expect(result).toMatchObject({ protocol: 'coursework.agent/v1', command: 'sync.run', ok: true, data: { outcome: 'OK', run: { command: 'sync', syncOutcome: 'OK', turns: 2, steps: 1 } } });
  expect(adapter.inputs[0]!.prompt).toContain(key);
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
