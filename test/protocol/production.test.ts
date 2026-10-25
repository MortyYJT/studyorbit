import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { synthetic } from '../fixtures/synthetic.js';
import { fakeCodex, fixture } from '../agent/fake-codex.js';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({ ...await importOriginal<object>(), query }));
const roots: string[] = []; const closes: (() => void)[] = [];
afterEach(async () => { closes.splice(0).forEach(close => close()); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'protocol-production-'))); roots.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  const host = createProductionProtocol({ owner: { assertOwner: async () => {} } }); closes.push(host.close);
  host.store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  return host;
}
it('omits unresolved name/answer-like IDs from durable autonomy audit', async () => {
  const host = await setup(); const assessmentId = 'Synthetic.Person/answer-is-42';
  expect(await dispatch(host.registry, 'autonomy.check', { assessmentId, action: 'fill' }, host.context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'assessment-unavailable' } });
  const raw = await readFile(join(process.env.COURSEWORK_HOME!, 'quiz', 'audit.jsonl'), 'utf8');
  expect(raw).not.toContain(assessmentId);
  const events = (await host.audit.list()).filter(event => event.command === 'autonomy.check');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ level: 0, decision: 'denied', code: 'INVALID_INPUT' });
  expect(events[0]).not.toHaveProperty('assessmentId');
});
it('production CLI reads real SQLite, uses private journals and survives reopen', async () => {
  const host = await setup(); const stdout: string[] = [];
  await parseProtocolCLI(['courses', 'list', '--json'], { ...host, stdout: value => stdout.push(value) });
  expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, data: { items: [synthetic.course] } });
  expect(await host.audit.list()).toHaveLength(2);
  host.close(); const next = createProductionProtocol(); closes.push(next.close);
  expect(await dispatch(next.registry, 'courses.list', {}, next.context)).toMatchObject({ ok: true, data: { items: [synthetic.course] } });
});
it('new owner settings survive reopen and legacy L4 grants remain unread and unchanged', async () => {
  const host = await setup();
  const call = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const policy = { version: 1, courseId: synthetic.course.id, status: 'owner-attested', attestation: 'Synthetic only', date: '2026-10-14', cap: 4 };
  const grant = { version: 1, courseId: synthetic.course.id, assessmentId: 'd', category: 'assignment', level: 4, date: '2026-10-14' };
  expect(await call('policy.record', policy)).toMatchObject({ ok: true });
  expect(await call('grant.record', grant)).toMatchObject({ ok: true });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'grant-level' } });
  await call('autonomy.default.set', { courseId: synthetic.course.id, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'd', level: 0 });
  host.close();
  const next = createProductionProtocol({ owner: { assertOwner: async () => {} } }); closes.push(next.close);
  expect(next.store.readCourseAutonomy(synthetic.course.id).at(-1)).toMatchObject({ defaultLevel: 2 });
  expect(await dispatch(next.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, next.context)).toMatchObject({ data: { decision: 'denied' } });
  await dispatch(next.registry, 'autonomy.override.clear', { assessmentId: 'd' }, next.context);
  expect(await dispatch(next.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, next.context)).toMatchObject({ data: { decision: 'allowed' } });
  const { ProtocolFiles } = await import('../../src/protocol/files.js');
  const { hash } = await import('../../src/citations/exact.js');
  expect(await new ProtocolFiles().read(`protocol-grant-${hash('d')}`)).toEqual(grant);
});
it('non-TTY CLI refuses both owner writes in one envelope without storing records', async () => {
  const host = await setup();
  for (const name of ['policy', 'grant']) {
    const stdout: string[] = [];
    const input = name === 'policy' ? ['--version', '1', '--course-id', synthetic.course.id, '--status', 'owner-attested', '--attestation', 'Synthetic', '--date', '2026-10-14', '--cap', '4']
      : ['--version', '1', '--course-id', synthetic.course.id, '--assessment-id', 'd', '--category', 'assignment', '--level', '4', '--date', '2026-10-14'];
    await parseProtocolCLI([name, 'record', ...input], { ...host, isTTY: false, stdout: s => stdout.push(s), stderr: () => {} });
    expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }
  expect(await dispatch(host.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, host.context)).toMatchObject({ ok: true, data: { reason: 'grant-level' } });
});
it('shared production file writer failure yields denied audit-unavailable', async () => {
  const host = await setup();
  const { ProtocolFiles } = await import('../../src/protocol/files.js');
  const { CourseworkError } = await import('../../src/protocol/errors.js');
  class BrokenFiles extends ProtocolFiles {
    override async append(): Promise<void> { throw new CourseworkError('INTERNAL', 'Synthetic writer outage'); }
  }
  const broken = createProductionProtocol({ store: host.store, files: new BrokenFiles(process.env.COURSEWORK_HOME) }); closes.push(broken.close);
  expect(await dispatch(broken.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, broken.context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'audit-unavailable' } });
});

it('production chat uses the Codex adapter by default without calling the Claude SDK', async () => {
  const fake = fakeCodex([{ fixture: fixture('codex-exec.jsonl') }]); closes.push(fake.cleanup);
  const host = await setup(); const owner = { assertOwner: async () => {} };
  const conversation = await host.chat.create({}, owner);
  expect(conversation.adapter).toBe('codex');
  await host.chat.send(conversation.id, 'Synthetic prompt', owner); await host.chat.waitForIdle(conversation.id);
  expect(fake.calls()).toHaveLength(1);
  expect(host.chat.open(conversation.id).conversation.sessionRef).toBe('t-1');
  expect(query).not.toHaveBeenCalled();
});

it('Claude on request: COURSEWORK_AGENT=claude uses the Claude SDK, never starts codex, and keeps explicit adapter overrides', async () => {
  const fake = fakeCodex([{ fixture: fixture('codex-exec.jsonl') }]); closes.push(fake.cleanup);
  vi.stubEnv('COURSEWORK_AGENT', 'claude');
  query.mockImplementation(() => Object.assign((async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic reply' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, session_id: 'synthetic-session' };
  })(), { interrupt: vi.fn() }));
  const host = await setup(); const owner = { assertOwner: async () => {} };
  const conversation = await host.chat.create({}, owner);
  expect(conversation.adapter).toBe('claude');
  const { messageId } = await host.chat.send(conversation.id, 'Synthetic prompt', owner);
  await host.chat.waitForIdle(conversation.id);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]![0]).toMatchObject({ prompt: expect.stringMatching(/Background from the coursework store[\s\S]*Synthetic prompt$/), options: { cwd: join(process.env.COURSEWORK_HOME!, 'agent-workspace') } });
  expect(host.chat.open(conversation.id).messages[1]!.parts).toEqual([{ type: 'text', text: 'Synthetic reply' }]);
  expect(host.store.loadRun(messageId)).toMatchObject({ turns: 1, costUsd: 0.01, outcome: 'ok' });
  const { unavailableAdapter } = await import('../../src/agent/adapter.js');
  const overridden = createProductionProtocol({ store: host.store, agentAdapter: unavailableAdapter });
  const other = await overridden.chat.create({}, owner);
  await overridden.chat.send(other.id, 'No SDK call', owner); await overridden.chat.waitForIdle(other.id);
  expect(overridden.chat.events(other.id).at(-1)!.event).toMatchObject({ type: 'error', code: 'AGENT_UNAVAILABLE' });
  expect(query).toHaveBeenCalledOnce();
  expect(fake.calls()).toHaveLength(0);
});

it('gives production chat the agent tool set and the live UI port', async () => {
  const { writeFile } = await import('node:fs/promises');
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const call = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: command, cwd: options.cwd }, command, {});
    for (const command of ['curl http://127.0.0.1:4568/api/status']) {
      expect((await call(command)).hookSpecificOutput.permissionDecision).toBe('deny');
    }
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'synthetic', version: '1' });
    await options.mcpServers.coursework.instance.connect(serverTransport); await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['courses.list', 'source.record']));
    expect(names).not.toContain('grant.record'); expect(names).not.toContain('sync.run');
    const listed = await client.callTool({ name: 'courses.list', arguments: {} });
    expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toMatchObject({ ok: true });
    await client.close();
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'synthetic-session' };
  })(), { interrupt: vi.fn() }));
  vi.stubEnv('COURSEWORK_AGENT', 'claude');
  const host = await setup(); const owner = { assertOwner: async () => {} };
  host.agentRuntime.frontendOrigin = 'http://127.0.0.1:4568';
  const conversation = await host.chat.create({}, owner);
  const { messageId } = await host.chat.send(conversation.id, 'Synthetic prompt', owner);
  await host.chat.waitForIdle(conversation.id);
  expect(host.store.loadRun(messageId)).toMatchObject({ outcome: 'ok', steps: 1 });
});

it('keeps the UI origin denial when a leftover browser.json is unreadable', async () => {
  const { writeFile } = await import('node:fs/promises');
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const command = 'curl http://127.0.0.1:4569/api/status';
    expect((await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'ui', cwd: options.cwd }, 'ui', {}))
      .hookSpecificOutput.permissionDecision).toBe('deny');
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'synthetic-session' };
  })(), { interrupt: vi.fn() }));
  vi.stubEnv('COURSEWORK_AGENT', 'claude');
  const host = await setup(); const owner = { assertOwner: async () => {} };
  await writeFile(join(process.env.COURSEWORK_HOME!, 'browser.json'), '{ corrupted');
  host.agentRuntime.frontendOrigin = 'http://127.0.0.1:4569';
  const conversation = await host.chat.create({}, owner);
  const { messageId } = await host.chat.send(conversation.id, 'Synthetic prompt', owner);
  await host.chat.waitForIdle(conversation.id);
  expect(host.store.loadRun(messageId)).toMatchObject({ outcome: 'ok', steps: 1 });
});
