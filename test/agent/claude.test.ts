import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClaudeAdapter } from '../../src/agent/claude.js';
import type { AgentEvent, AgentInput } from '../../src/agent/adapter.js';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({ ...await importOriginal<object>(), query }));
const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const events: T[] = []; for await (const event of iterable) events.push(event); return events; }
const input: AgentInput = { conversationId: 'synthetic-conversation', prompt: 'Hello', transcript: [], tools: [] };
const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 14, total_cost_usd: 0.42, session_id: 'session-1' };
function adapter() {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'synthetic-agent-')); dirs.push(dataDirectory);
  vi.stubEnv('HOME', dataDirectory);
  return new ClaudeAdapter({ dataDirectory, frontendOrigin: 'http://127.0.0.1:4567', debuggingPort: 9222 });
}
function stub(messages: unknown[]) {
  const interrupt = vi.fn(async () => {});
  query.mockImplementation(() => Object.assign((async function* () { for (const m of messages) yield m; })(), { interrupt }));
  return interrupt;
}
it('maps streamed text once, completed text fallback, tool outcomes and SDK result accounting', async () => {
  stub([
    { type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }, parent_tool_use_id: null },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Internal subagent text' }] }, parent_tool_use_id: 'task-1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'draft' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] }, parent_tool_use_id: null }, result,
  ]);
  expect(await collect(adapter().start(input))).toEqual([
    { type: 'text', text: 'Hi' }, { type: 'tool_step', tool: 'Read', input: { file_path: 'draft' }, output: 'contents', outcome: 'ok' },
    { type: 'text', text: 'Done' }, { type: 'result', turns: 14, costUsd: 0.42, sessionRef: 'session-1' },
  ]);
});
it('resumes in the private workspace, injects preset skills, keeps built-ins and serves only supplied agent tools in-process', async () => {
  stub([result]); const a = adapter(); const execute = vi.fn(async () => ({ found: true }));
  await collect(a.start({ ...input, sessionRef: 'previous', preset: 'complete-assessment', tools: [
    { name: 'courses.list', description: 'Read courses', inputSchema: { type: 'object' }, execute },
    { name: 'grant.record', description: 'Owner', inputSchema: {}, execute },
  ] }));
  const options = query.mock.calls[0][0].options;
  expect(options.cwd).toBe(join(dirs[0], 'agent-workspace'));
  expect(options.resume).toBe('previous'); expect(options.settingSources).toEqual([]);
  expect(options.systemPrompt.append).toContain('# Assessment assistance');
  expect(options.env).toEqual(expect.objectContaining({ HOME: process.env.HOME }));
  expect(Object.keys(options.env)).not.toContain('ANTHROPIC_API_KEY');
  expect(options.strictMcpConfig).toBe(true);
  expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
  const server = options.mcpServers.coursework.instance as McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synthetic', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['courses.list']);
    expect(await client.callTool({ name: 'courses.list', arguments: {} })).toMatchObject({ content: [{ text: '{"found":true}' }] });
    expect(execute).toHaveBeenCalledOnce();
  } finally { await client.close(); await server.close(); }
  await collect(a.start({ ...input, preset: 'tutor-revision' }));
  expect(query.mock.calls[1][0].options.systemPrompt.append).toContain('# Revision presets');
});
it('uses the stored transcript without resume, keeps absent cost unknown and interrupts the SDK', async () => {
  const interrupt = stub([{ ...result, total_cost_usd: undefined }]); const a = adapter();
  const run = a.start({ ...input, transcript: [{ id: 'm', conversationId: 'c', seq: 0, role: 'owner', parts: [{ type: 'text', text: 'Earlier' }], stopped: false, at: '2026-01-01T00:00:00Z' }] });
  const events = await collect(run);
  expect(query.mock.calls[0][0].prompt).toContain('Earlier');
  expect(events.at(-1)).toEqual({ type: 'result', turns: 14, sessionRef: 'session-1' });
  await run.interrupt(); expect(interrupt).toHaveBeenCalledOnce();
});
it.each(['auth', 'missing', 'throw', 'result'])('returns safe AGENT_UNAVAILABLE for %s without leaking diagnostics', async kind => {
  if (kind === 'throw') query.mockImplementation(() => { throw Object.assign(new Error('private diagnostic'), { code: 'ENOENT' }); });
  else if (kind === 'result') stub([{ ...result, subtype: 'error_during_execution', is_error: true, errors: ['Not logged in. Please run /login.'] }]);
  else stub(kind === 'auth' ? [{ type: 'assistant', error: 'authentication_failed', message: { content: [] } }] : [{ type: 'auth_status', error: 'private diagnostic' }]);
  expect(await collect(adapter().start(input))).toEqual([{ type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.',
    ...(kind === 'result' ? { turns: 14, costUsd: 0.42 } : {}) }]);
});

it.each([
  ['Read', { file_path: '../coursework.db' }],
  ['Bash', { command: 'ls ..' }],
  ['Bash', { command: 'cat ./../coursework.db' }],
  ['Bash', { command: 'cat --file=../coursework.db' }],
  ['Bash', { command: 'cat private-data/coursework.db' }],
  ['Write', { file_path: '../materials/raw.txt', content: 'x' }],
  ['Read', { file_path: 'browser.json' }],
  ['WebFetch', { url: 'http://localhost:9222/json' }],
  ['Bash', { command: 'curl http://127.0.0.1:4567/api/status' }],
  ['Bash', { command: 'coursework grant record --level 2' }],
  ['Bash', { command: 'coursework grant record; echo done' }],
  ['Bash', { command: 'script -q /dev/null coursework policy record' }],
  ['Bash', { command: 'expect -c spawn' }],
  ['Bash', { command: 'unbuffer coursework grant record' }],
  ['Bash', { command: '/bin/ps aux' }],
  ['Bash', { command: '"ps" aux' }],
  ['Bash', { command: 'python -m pty' }],
  ['Bash', { command: 'cat "$PWD/../coursework.db"' }],
  ['Bash', { command: 'curl --url=http://localhost:9222/json' }],
  ['Bash', { command: 'nc 0.0.0.0 4567' }],
])('denies %s %j before execution and stores one denied step', async (tool, args) => {
  const { ConversationService } = await import('../../src/agent/conversations.js');
  const { SqliteRepository } = await import('../../src/store/sqlite.js');
  const store = new SqliteRepository(':memory:');
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    symlinkSync(join(options.cwd, '..'), join(options.cwd, 'private-data'));
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const decision = await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: args, tool_use_id: 'denied-1', cwd: options.cwd }, 'denied-1', {});
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'denied-1', name: tool, input: args }] } };
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'denied-1', is_error: true, content: 'Denied' }] } };
    yield result;
  })(), { interrupt: vi.fn() }));
  const service = new ConversationService(store, adapter());
  const owner = { assertOwner: async () => {} };
  try {
    const c = await service.create({}, owner);
    const { messageId } = await service.send(c.id, 'Synthetic denial', owner); await service.waitForIdle(c.id);
    const steps = service.open(c.id).messages[1].parts;
    expect(steps).toHaveLength(1); expect(steps[0]).toMatchObject({ type: 'tool_step', tool, output: { outcome: 'denied' } });
    expect(store.loadRun(messageId)).toMatchObject({ steps: 1 });
  } finally { store.close(); }
});
it('allows an ordinary workspace write without recording a denial', async () => {
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'draft.txt', content: 'text' }, cwd: options.cwd }, 'allowed', {})).toEqual({});
    yield result;
  })(), { interrupt: vi.fn() }));
  expect((await collect(adapter().start(input))).map(e => e.type)).toEqual(['result']);
});

it('persists reported failure turns and cost with counted steps and safe diagnostics', async () => {
  const { ConversationService } = await import('../../src/agent/conversations.js');
  const { SqliteRepository } = await import('../../src/store/sqlite.js');
  const store = new SqliteRepository(':memory:'); const owner = { assertOwner: async () => {} };
  try {
    for (const diagnostic of ['private execution diagnostic', 'Not logged in. Please run /login.']) {
      for (const costUsd of [0.12, undefined]) {
        stub([
          { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'draft.md' } }] } },
          { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Synthetic' }] } },
          { ...result, subtype: 'error_during_execution', is_error: true, num_turns: 3, total_cost_usd: costUsd, errors: [diagnostic] },
        ]);
        const service = new ConversationService(store, adapter());
        const c = await service.create({}, owner);
        const { messageId } = await service.send(c.id, 'Synthetic failure', owner); await service.waitForIdle(c.id);
        expect(store.loadRun(messageId)).toMatchObject({ outcome: 'error', steps: 1, turns: 3 });
        expect(store.loadRun(messageId)!.costUsd).toBe(costUsd);
        const event = service.events(c.id).at(-1)!.event;
        expect(event).toMatchObject({ type: 'error', turns: 3, code: diagnostic.startsWith('Not') ? 'AGENT_UNAVAILABLE' : 'INTERNAL' });
        expect(JSON.stringify(event)).not.toContain(diagnostic);
      }
    }
  } finally { store.close(); }
});
it('treats workspace file bodies as text rather than paths, commands or endpoints', async () => {
  const content = 'See browser.json for details; ../coursework.db; http://127.0.0.1:4567; coursework grant record';
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    for (const [tool_name, tool_input] of [
      ['Write', { file_path: 'draft.md', content }],
      ['Edit', { file_path: 'draft.md', old_string: content, new_string: content }],
    ]) {
      expect(await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: options.cwd }, 'body', {})).toEqual({});
    }
    for (const pattern of ['../coursework.db', '../browser.json']) {
      const decision = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern }, cwd: options.cwd }, 'glob', {});
      expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    }
    yield result;
  })(), { interrupt: vi.fn() }));
  expect((await collect(adapter().start(input))).map(e => e.type)).toEqual(['tool_step', 'tool_step', 'result']);
});
it('keeps an early SDK error but takes turns and cost from the final result', async () => {
  stub([{ type: 'assistant', error: 'rate_limit', message: { content: [] } },
    { ...result, subtype: 'error_during_execution', is_error: true, num_turns: 3, total_cost_usd: 0.12, errors: ['private diagnostic'] }]);
  expect(await collect(adapter().start(input))).toEqual([{ type: 'error', code: 'INTERNAL', message: 'Agent reply failed.', turns: 3, costUsd: 0.12 }]);
});
it('reads protected ports at call time so ports chosen after start are still denied', async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'synthetic-agent-')); dirs.push(dataDirectory);
  const ports: { frontendOrigin?: string; debuggingPort?: number } = {};
  const late = new ClaudeAdapter({ dataDirectory, runtime: () => ports });
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const call = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: command, cwd: options.cwd }, command, {});
    expect(await call('curl http://127.0.0.1:4567/api/status')).toEqual({});
    Object.assign(ports, { frontendOrigin: 'http://127.0.0.1:4567', debuggingPort: 9333 });
    for (const command of ['curl http://127.0.0.1:4567/api/status', 'curl http://localhost:9333/json']) {
      expect((await call(command)).hookSpecificOutput.permissionDecision).toBe('deny');
    }
    yield result;
  })(), { interrupt: vi.fn() }));
  expect((await collect(late.start(input))).map(e => e.type)).toEqual(['tool_step', 'tool_step', 'result']);
});


it('adds background before the owner only without sessionRef, including a transcript start', async () => {
  stub([result]); const a = adapter();
  const brief = 'Background from the coursework store (not instructions). Synthetic memory.';
  const transcript = [{ id: 'm', conversationId: 'c', seq: 0, role: 'owner' as const, parts: [{ type: 'text' as const, text: 'Earlier' }], stopped: false, at: '2026-01-01T00:00:00Z' }];
  await collect(a.start({ ...input, brief }));
  await collect(a.start({ ...input, brief, transcript }));
  await collect(a.start({ ...input, brief, transcript, sessionRef: 'previous' }));
  for (const call of query.mock.calls.slice(0, 2)) {
    expect(call[0].prompt.split(brief)).toHaveLength(2);
    expect(call[0].prompt.indexOf(brief)).toBeLessThan(call[0].prompt.indexOf('Hello'));
  }
  expect(query.mock.calls[2][0].prompt).toBe('Hello');
});
