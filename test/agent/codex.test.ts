import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CodexAdapter } from '../../src/agent/codex.js';
import { ConversationService } from '../../src/agent/conversations.js';
import { packageRoot } from '../../src/config/data-dir.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import type { AgentInput } from '../../src/agent/adapter.js';
import type { Message } from '../../src/domain/schemas.js';
import { alive, fakeCodex, fixture, until, type FakeRun } from './fake-codex.js';

const owner = { assertOwner: async () => {} };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const fn of cleanups.splice(0).reverse()) fn(); });
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const events: T[] = []; for await (const event of iterable) events.push(event); return events; }
function setup(runs: FakeRun[]) {
  const fake = fakeCodex(runs); cleanups.push(fake.cleanup);
  const adapter = new CodexAdapter({ dataDirectory: fake.data, killAfterMs: 300 });
  const workspace = join(fake.home, '.coursework', 'codex-workspace', createHash('sha256').update(resolve(fake.data)).digest('hex').slice(0, 12));
  return { ...fake, adapter, workspace };
}
function chat(adapter: CodexAdapter, path = ':memory:') {
  const store = new SqliteRepository(path); cleanups.push(() => store.close());
  return { store, service: new ConversationService(store, adapter) };
}
const input: AgentInput = { prompt: 'Hello', transcript: [], tools: [] };
const configs = (argv: string[]) => argv.flatMap((arg, i) => arg === '-c' ? [argv[i + 1]!] : []);
const message = (seq: number, role: 'owner' | 'agent', text: string): Message =>
  ({ id: `m-${seq}`, conversationId: 'c', seq, role, parts: [{ type: 'text', text }], stopped: false, at: '2026-10-24T00:00:00.000Z' });

it('Codex events: streams text, ok and error tool steps, ignores unknown items and reports 1 turn, t-1 and no cost', async () => {
  const { adapter } = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  expect(await collect(adapter.start(input))).toEqual([
    { type: 'text', text: 'Synthetic reply.' },
    { type: 'tool_step', tool: 'coursework.courses.list', outcome: 'ok' },
    { type: 'tool_step', tool: 'coursework.assessments.get', outcome: 'error' },
    { type: 'result', turns: 1, sessionRef: 't-1' },
  ]);
});

it('maps shell and computer-use steps by name and outcome only and never stores raw Codex output', async () => {
  const s = setup([{ fixture: fixture('codex-tools.jsonl'), stderr: 'SYNTHETIC-STDERR\n' }]);
  const { store, service } = chat(s.adapter, join(s.data, 'coursework.db'));
  const c = await service.create({}, owner);
  const { messageId } = await service.send(c.id, 'Hello', owner); await service.waitForIdle(c.id);
  expect(service.open(c.id).messages[1]!.parts).toEqual([
    { type: 'tool_step', tool: 'shell', output: { outcome: 'ok' } },
    { type: 'tool_step', tool: 'shell', output: { outcome: 'error' } },
    { type: 'tool_step', tool: 'computer', output: { outcome: 'ok' } },
    { type: 'tool_step', tool: 'coursework.plan.read', output: { outcome: 'error' } },
    { type: 'text', text: 'Done.' },
  ]);
  const run = store.loadRun(messageId);
  expect(run).toMatchObject({ turns: 2, steps: 4, outcome: 'ok' }); expect(run).not.toHaveProperty('costUsd');
  store.close();
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  const written = [...files(s.data), ...files(s.home)];
  expect(written.length).toBeGreaterThan(1);
  for (const file of written) expect(readFileSync(file, 'latin1')).not.toMatch(/SYNTHETIC-(?:OUTPUT|COMMAND|SCREEN|ERROR|NOISE|STDERR)/);
});

it('Resume: a stored session reference runs codex exec resume t-1 with only the new message', async () => {
  const s = setup([{ fixture: fixture('codex-resume.jsonl') }]);
  const events = await collect(s.adapter.start({ ...input, prompt: 'Second message', sessionRef: 't-1', transcript: [message(0, 'owner', 'Earlier'), message(1, 'agent', 'Reply')] }));
  expect(events).toEqual([{ type: 'text', text: 'Resumed reply.' }, { type: 'result', turns: 1, sessionRef: 't-1' }]);
  const [call] = s.calls();
  expect(call!.argv.slice(0, 3)).toEqual(['exec', 'resume', 't-1']);
  expect(call!.argv).toContain('--json'); expect(call!.argv.at(-1)).toBe('-');
  expect(call!.stdin).toBe('Second message');
});

it('Resume fails: falls back to a new thread with the stored transcript and replaces t-1 without an error', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }, { stderr: 'Error: no thread found with id t-1\n', exit: 1 }, { fixture: fixture('codex-new-thread.jsonl') }]);
  const { service } = chat(s.adapter);
  const c = await service.create({}, owner);
  await service.send(c.id, 'First message', owner); await service.waitForIdle(c.id);
  expect(service.open(c.id).conversation.sessionRef).toBe('t-1');
  await service.send(c.id, 'Second message', owner); await service.waitForIdle(c.id);
  const calls = s.calls();
  expect(calls.map(call => call.argv.slice(0, 2))).toEqual([['exec', '--json'], ['exec', 'resume'], ['exec', '--json']]);
  expect(calls[2]!.stdin).toContain('First message'); expect(calls[2]!.stdin).toContain('Synthetic reply.');
  expect(calls[2]!.stdin).toMatch(/Second message$/);
  const opened = service.open(c.id);
  expect(opened.conversation.sessionRef).toBe('t-9');
  expect(opened.messages[3]!.parts).toEqual([{ type: 'text', text: 'Fresh reply.' }]);
  expect(opened.events.some(e => e.event.type === 'error')).toBe(false);
});

it('Stop a Codex reply: SIGTERM, then SIGKILL when the child ignores it, and a stopped message', async () => {
  const s = setup([{ stdout: ['{"type":"thread.started","thread_id":"t-3"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Partial"}}'], hang: true }]);
  const { service } = chat(s.adapter);
  const c = await service.create({}, owner);
  await service.send(c.id, 'Long task', owner);
  await until(() => service.events(c.id).some(e => e.event.type === 'text'));
  await service.stop(c.id, owner);
  const pid = s.calls()[0]!.pid;
  await until(() => s.signals().includes('TERM'));
  expect(alive(pid)).toBe(true);
  await until(() => !alive(pid));
  expect(service.open(c.id).messages[1]).toMatchObject({ stopped: true, parts: [{ type: 'text', text: 'Partial' }] });
});

it.each([
  ['missing executable', [], 'AGENT_UNAVAILABLE'],
  ['signed-out exit', [{ stderr: 'Error: Not logged in. Run codex login.\n', exit: 1 }], 'AGENT_UNAVAILABLE'],
  ['other failure', [{ stderr: 'SYNTHETIC-CRASH at /private/synthetic\n', exit: 2 }], 'INTERNAL'],
] as const)('Agent not signed in: %s returns a safe %s error', async (kind, runs, code) => {
  const s = setup([...runs]);
  if (kind === 'missing executable') { const empty = join(s.root, 'empty'); mkdirSync(empty); vi.stubEnv('PATH', empty); }
  const events = await collect(s.adapter.start(input));
  expect(events).toEqual([{ type: 'error', code, message: code === 'INTERNAL' ? 'Agent reply failed.' : 'Sign in to the installed agent and retry.' }]);
});

it('Owner command through the shell: workspace-write sandbox in the workspace, pre-approved MCP, no bypass flags, minimal env', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start(input));
  const [call] = s.calls();
  expect(call!.cwd).toBe(s.workspace);
  expect(configs(call!.argv)).toEqual(expect.arrayContaining(['sandbox_mode="workspace-write"', 'mcp_servers.coursework.default_tools_approval_mode="approve"']));
  for (const flag of ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '-s', '--sandbox', '-C', '--cd', '-a', '--ask-for-approval']) expect(call!.argv).not.toContain(flag);
  expect(configs(call!.argv).some(value => /approval_policy|danger-full-access/.test(value))).toBe(false);
  expect(call!.env.OPENAI_API_KEY).toBeUndefined(); expect(call!.env.COURSEWORK_HOME).toBeUndefined();
  expect(call!.env.HOME).toBe(s.home);
});

it('Same data directory: the MCP server entry carries COURSEWORK_HOME and the codex profile', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start(input));
  const values = configs(s.calls()[0]!.argv);
  expect(values).toEqual(expect.arrayContaining([`mcp_servers.coursework.env.COURSEWORK_HOME=${JSON.stringify(s.data)}`,
    'mcp_servers.coursework.env.COURSEWORK_MCP_PROFILE="codex"', `mcp_servers.coursework.command=${JSON.stringify(process.execPath)}`]));
  const args = values.find(value => value.startsWith('mcp_servers.coursework.args='))!;
  expect(JSON.parse(args.slice(args.indexOf('=') + 1))).toEqual([join(packageRoot(), 'dist', 'cli.js'), 'mcp']);
});

it('Workspace instructions: a private workspace with no Git tree above it gets the five rules before the child starts', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start(input));
  expect(statSync(s.workspace).mode & 0o777).toBe(0o700);
  for (let dir = s.workspace; dir !== dirname(dir); dir = dirname(dir)) expect(existsSync(join(dir, '.git'))).toBe(false);
  const agents = s.calls()[0]!.agents!;
  for (const rule of [/never press a final submit/i, /sign-in page/i, /never type a password/i, /prohibits AI/i, /level the owner granted/i, /other sites or tabs/i]) expect(agents).toMatch(rule);
  writeFileSync(join(s.workspace, 'AGENTS.md'), 'Synthetic tampering.');
  await collect(s.adapter.start(input));
  expect(s.calls()[1]!.agents).toBe(agents);
});

it('carries the preset skill text in the prompt', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start({ ...input, preset: 'prepare-revision' }));
  const skill = readFileSync(join(packageRoot(), 'skills', 'revision', 'SKILL.md'), 'utf8');
  expect(s.calls()[0]!.stdin).toContain(skill); expect(s.calls()[0]!.stdin).toMatch(/Hello$/);
});
