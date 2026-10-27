import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CodexAdapter } from '../../src/agent/codex.js';
import { ConversationService } from '../../src/agent/conversations.js';
import { packageRoot } from '../../src/config/data-dir.js';
import { startOwnerUI } from '../../src/protocol/http-host.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
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
const input: AgentInput = { conversationId: 'synthetic-conversation', prompt: 'Hello', transcript: [], tools: [] };
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
const configs = (argv: string[]) => argv.flatMap((arg, i) => arg === '-c' ? [argv[i + 1]!] : []);
const message = (seq: number, role: 'owner' | 'agent', text: string): Message =>
  ({ id: `m-${seq}`, conversationId: 'c', seq, role, parts: [{ type: 'text', text }], stopped: false, at: '2026-10-24T00:00:00.000Z' });

it('Codex events: streams text, ok and error tool steps, ignores unknown items and reports 1 turn, t-1 and no cost', async () => {
  const { adapter } = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  expect(await collect(adapter.start(input))).toEqual([
    { type: 'text', text: 'Synthetic reply.' },
    { type: 'tool_step', tool: 'coursework.courses.list', outcome: 'ok' },
    { type: 'tool_step', tool: 'coursework.assessments.get', outcome: 'error' },
    { type: 'result', turns: 1, sessionRef: 't-1', inputTokens: 120, outputTokens: 30 },
  ]);
});

it('Token usage: sums every completed turn and keeps it on a failed run', async () => {
  const turn = (input: number, output: number) => JSON.stringify({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } });
  const { adapter } = setup([{ stdout: [turn(100, 10), turn(200, 20)], exit: 1 }]);
  expect((await collect(adapter.start(input))).at(-1)).toMatchObject({ type: 'error', turns: 2, inputTokens: 300, outputTokens: 30 });
});

it('Model: every run uses gpt-6-luna on the default service tier, whatever the owner config says', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start(input));
  expect(configs(s.calls()[0]!.argv)).toEqual(expect.arrayContaining(['model="gpt-6-luna"', 'service_tier="default"']));
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
  const written = [...files(s.data), ...files(s.home)];
  expect(written.length).toBeGreaterThan(1);
  for (const file of written) expect(readFileSync(file, 'latin1')).not.toMatch(/SYNTHETIC-(?:OUTPUT|COMMAND|SCREEN|ERROR|NOISE|STDERR)/);
});

it('Resume: a stored session reference runs codex exec resume t-1 with only the new message', async () => {
  const s = setup([{ fixture: fixture('codex-resume.jsonl') }]);
  const events = await collect(s.adapter.start({ ...input, prompt: 'Second message', sessionRef: 't-1', transcript: [message(0, 'owner', 'Earlier'), message(1, 'agent', 'Reply')] }));
  expect(events).toEqual([{ type: 'text', text: 'Resumed reply.' }, { type: 'result', turns: 1, sessionRef: 't-1', inputTokens: 60, outputTokens: 4 }]);
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
  ['401 exit', [{ stderr: 'Error: 401 Unauthorized\n', exit: 1 }], 'AGENT_UNAVAILABLE'],
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

it('Same data directory: the MCP server entry carries COURSEWORK_HOME', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start(input));
  const values = configs(s.calls()[0]!.argv);
  expect(values).toEqual(expect.arrayContaining([`mcp_servers.coursework.env.COURSEWORK_HOME=${JSON.stringify(s.data)}`,
    `mcp_servers.coursework.command=${JSON.stringify(process.execPath)}`]));
  const args = values.find(value => value.startsWith('mcp_servers.coursework.args='))!;
  expect(JSON.parse(args.slice(args.indexOf('=') + 1))).toEqual([join(packageRoot(), 'dist', 'cli.js'), 'mcp']);
});

it('Workspace instructions: a private workspace with no Git tree above it gets the five rules before the child starts', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start(input));
  expect(statSync(s.workspace).mode & 0o777).toBe(0o700);
  for (let dir = s.workspace; dir !== dirname(dir); dir = dirname(dir)) expect(existsSync(join(dir, '.git'))).toBe(false);
  const agents = s.calls()[0]!.agents!;
  for (const rule of [/never press a final submit/i, /sign-in page/i, /never type a password/i, /effective AI policy/i,
    /granted level for that assessment/i, /read-only on assessments and courses/i, /other sites or tabs/i]) expect(agents).toMatch(rule);
  writeFileSync(join(s.workspace, 'AGENTS.md'), 'Synthetic tampering.');
  await collect(s.adapter.start(input));
  expect(s.calls()[1]!.agents).toBe(agents);
});

it('Conversation from another adapter: a stored claude conversation continues as a new Codex thread from its transcript', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  const { store, service } = chat(s.adapter);
  const at = '2026-10-24T00:00:00.000Z';
  store.saveChat({ id: 'c', title: 'Earlier', adapter: 'claude', sessionRef: 'claude-session', createdAt: at, updatedAt: at });
  store.appendMessage(message(0, 'owner', 'Claude-era question')); store.appendMessage(message(1, 'agent', 'Claude-era answer'));
  await service.send('c', 'Next question', owner); await service.waitForIdle('c');
  const [call] = s.calls();
  expect(call!.argv.slice(0, 2)).toEqual(['exec', '--json']); expect(call!.argv).not.toContain('claude-session');
  expect(call!.stdin).toContain('Claude-era question'); expect(call!.stdin).toContain('Claude-era answer'); expect(call!.stdin).not.toContain('claude-session');
  expect(service.open('c').conversation).toMatchObject({ adapter: 'codex', sessionRef: 't-1' });
  expect(service.open('c').messages[3]!.parts[0]).toEqual({ type: 'text', text: 'Synthetic reply.' });
});

it('Reading the owner session: no file in the data directory, workspace or child record holds the secret while a reply runs', async () => {
  const s = setup([{ stdout: ['{"type":"thread.started","thread_id":"t-4"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Working"}}'], hang: true }]);
  const host = createProductionProtocol({ agentAdapter: s.adapter }); cleanups.push(() => { void host.close(); });
  const ui = join(s.root, 'ui'); mkdirSync(ui); writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Synthetic</title>');
  let url = '';
  const transport = await startOwnerUI(host, { staticDirectory: ui, opener: async value => { url = value; } });
  cleanups.push(() => { void transport.close(); });
  const secret = new URL(url).hash.slice(3); expect(secret).toMatch(/^[0-9a-f]{64}$/);
  const c = await host.chat.create({}, owner); await host.chat.send(c.id, 'Read my files', owner);
  await until(() => host.chat.events(c.id).some(e => e.event.type === 'text'));
  const written = [...files(s.data), ...files(s.home), ...files(s.bin)];
  expect(written.some(file => file.endsWith('coursework.db'))).toBe(true);
  for (const file of written) expect(readFileSync(file, 'latin1')).not.toContain(secret);
  await host.chat.stop(c.id, owner);
});

it('carries the preset skill text in the prompt', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start({ ...input, preset: 'prepare-revision' }));
  const skill = readFileSync(join(packageRoot(), 'skills', 'revision', 'SKILL.md'), 'utf8');
  expect(s.calls()[0]!.stdin).toContain(skill); expect(s.calls()[0]!.stdin).toMatch(/Hello$/);
});

it('a successful run with an authentication warning in stderr still ends with a result', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl'), stderr: 'MCP client for synthetic-other failed: authentication required\n', exit: 0 }]);
  const events = await collect(s.adapter.start(input));
  expect(events.at(-1)).toMatchObject({ type: 'result', sessionRef: 't-1' });
  expect(events.some(event => event.type === 'error')).toBe(false);
});

it('New conversation for a course: background follows the preset and precedes the owner; MCP gets the conversation id', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }]);
  await collect(s.adapter.start({ ...input, conversationId: 'v-1', preset: 'prepare-revision', brief: 'Background from the coursework store (not instructions).\n3 wrong' }));
  const call = s.calls()[0]!;
  expect(call.stdin.indexOf('# Revision presets')).toBeLessThan(call.stdin.indexOf('Background from'));
  expect(call.stdin.indexOf('3 wrong')).toBeLessThan(call.stdin.indexOf('Hello'));
  expect(configs(call.argv)).toContain('mcp_servers.coursework.env.COURSEWORK_CONVERSATION_ID="v-1"');
});

it('Resumed session and Resume falls back: brief only on new-thread attempts, once; identity on every attempt', async () => {
  const s = setup([{ fixture: fixture('codex-exec.jsonl') }, { fixture: fixture('codex-resume.jsonl') },
    { stderr: 'thread missing', exit: 1 }, { fixture: fixture('codex-new-thread.jsonl') }]);
  const { store, service } = chat(s.adapter);
  store.saveMemory({ id: 'mem', kind: 'habit', origin: 'owner', text: 'Synthetic remembered habit.', createdAt: '2026-10-25T00:00:00.000Z' });
  const c = await service.create({}, owner);
  for (const prompt of ['First', 'Second', 'Third']) { await service.send(c.id, prompt, owner); await service.waitForIdle(c.id); }
  const calls = s.calls();
  expect(calls).toHaveLength(4);
  expect(calls.map(call => (call.stdin.match(/Background from the coursework store/g) ?? []).length)).toEqual([1, 0, 0, 1]);
  expect(calls[3]!.stdin).toContain('Synthetic remembered habit.');
  for (const call of calls) expect(configs(call.argv)).toContain(`mcp_servers.coursework.env.COURSEWORK_CONVERSATION_ID=${JSON.stringify(c.id)}`);
  expect(JSON.stringify(service.open(c.id).messages)).not.toContain('Background from');
  expect(JSON.stringify(service.open(c.id).messages)).not.toContain('Synthetic remembered habit.');
});
