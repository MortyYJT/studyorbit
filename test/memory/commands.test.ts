import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { ownerCommands } from '../../src/protocol/contracts.js';
import { createMcpServer } from '../../src/protocol/mcp.js';
import { collectBrief } from '../../src/memory/brief.js';

type Result = { ok: boolean; data?: any; error?: { code: string; message: string; retryable: boolean } };
const roots: string[] = []; const hosts: ReturnType<typeof createProductionProtocol>[] = []; const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const h of hosts.splice(0)) await h.close(); vi.unstubAllEnvs(); vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const owner = { assertOwner: async () => {} };
async function setup(options: Parameters<typeof createProductionProtocol>[0] = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-'))); roots.push(root); vi.stubEnv('COURSEWORK_HOME', root); vi.stubEnv('HOME', root);
  const host = createProductionProtocol(options); hosts.push(host);
  host.store.saveCourse({ id: 'c-1', moduleId: 'm', code: 'SYNA10001', name: 'Synthetic algebra', term: '2026:S2', assessmentsComplete: true });
  host.store.saveChat({ id: 'v-1', title: 'Tutoring', adapter: 'codex', courseId: 'c-1', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' });
  const agent = host.registry.agentTools(host.context);
  // The calling session's conversation is host-supplied context, never command input.
  const asAgent = (name: string, input: unknown, conversationId?: string) =>
    dispatch(agent.registry, name, input, conversationId ? { ...agent.context, conversationId } : agent.context) as Promise<Result>;
  const asOwner = (name: string, input: unknown) => dispatch(host.registry, name, input, { ...host.context, owner }) as Promise<Result>;
  const list = async (input: unknown = {}) => (await asAgent('memory.list', input)).data?.items as any[];
  return { host, agent, asAgent, asOwner, list };
}

it('Weakness noticed while tutoring: memory.list returns it with kind, course, today and source v-1', async () => {
  const { asAgent, list } = await setup();
  const recorded = await asAgent('memory.record', { courseId: 'c-1', kind: 'weakness', text: 'Mixes up eigenvalues and eigenvectors' }, 'v-1');
  expect(recorded).toMatchObject({ ok: true, data: { recorded: true } });
  const [item, ...rest] = await list();
  expect(rest).toEqual([]);
  expect(item).toMatchObject({ id: recorded.data.id, kind: 'weakness', courseId: 'c-1', origin: 'agent', conversationId: 'v-1',
    text: 'Mixes up eigenvalues and eigenvectors' });
  expect(item.createdAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  expect(await list({ courseId: 'other' })).toEqual([]);
});

it('a source id in the command input is refused; without a session the memory is stored without a source', async () => {
  const { asAgent, list } = await setup();
  expect(await asAgent('memory.record', { kind: 'habit', text: 'Studies late', conversationId: 'v-1' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await asAgent('memory.record', { kind: 'habit', text: 'Studies late at night' })).toMatchObject({ ok: true });
  const [item] = await list();
  expect(item).not.toHaveProperty('conversationId'); expect(item).not.toHaveProperty('sourceDeleted');
});

it('Too long or unknown course: refused and nothing is stored', async () => {
  const { asAgent, host } = await setup();
  expect(await asAgent('memory.record', { kind: 'other', text: 'x'.repeat(501) }, 'v-1')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await asAgent('memory.record', { courseId: 'missing', kind: 'other', text: 'Fine text' }, 'v-1')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await asAgent('memory.record', { kind: 'mood', text: 'Fine text' }, 'v-1')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(host.store.listMemories()).toEqual([]);
});

it('Owner adds a memory: origin owner and no source conversation', async () => {
  const { asOwner, list } = await setup();
  expect(await asOwner('memory.add', { kind: 'preference', text: 'Explain with an example first' })).toMatchObject({ ok: true, data: { recorded: true } });
  const [item] = await list();
  expect(item).toMatchObject({ kind: 'preference', origin: 'owner', text: 'Explain with an example first' });
  expect(item).not.toHaveProperty('conversationId'); expect(item).not.toHaveProperty('courseId');
});

it('Owner edits an observation: text changes, creation time and source stay, edit time is recorded', async () => {
  const { asAgent, asOwner, list, host } = await setup();
  const { data } = await asAgent('memory.record', { courseId: 'c-1', kind: 'weakness', text: 'Mixes up eigenvalues and eigenvectors' }, 'v-1');
  const before = host.store.loadMemory(data.id)!;
  expect(await asOwner('memory.edit', { id: data.id, text: 'Confuses eigenvalues with eigenvectors', kind: 'other' })).toMatchObject({ ok: true });
  const after = host.store.loadMemory(data.id)!;
  expect(after).toMatchObject({ text: 'Confuses eigenvalues with eigenvectors', kind: 'other', createdAt: before.createdAt, conversationId: 'v-1', origin: 'agent', courseId: 'c-1' });
  expect(after.editedAt).toBeDefined();
  expect((await list())[0]).toMatchObject({ text: 'Confuses eigenvalues with eigenvectors', editedAt: after.editedAt });
  expect(await asOwner('memory.edit', { id: data.id })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await asOwner('memory.edit', { id: 'missing', text: 'x' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

it('Owner deletes a wrong observation: gone from memory.list, the row remains marked deleted, later edits refused', async () => {
  const { asAgent, asOwner, list, host } = await setup();
  const { data } = await asAgent('memory.record', { kind: 'habit', text: 'Skips lectures' }, 'v-1');
  expect(await asOwner('memory.delete', { id: data.id })).toMatchObject({ ok: true });
  expect(await list()).toEqual([]);
  expect(collectBrief(host.store, {})).not.toContain('Skips lectures');
  expect(host.store.loadMemory(data.id)!.deletedAt).toBeDefined();
  expect(await asOwner('memory.edit', { id: data.id, text: 'Back again' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(await asOwner('memory.delete', { id: data.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

it('a deleted source conversation is reported as deleted, not linked', async () => {
  const { asAgent, list, host } = await setup();
  await asAgent('memory.record', { kind: 'habit', text: 'Prefers short sessions' }, 'v-1');
  host.store.deleteConversation('v-1');
  const [item] = await list();
  expect(item).not.toHaveProperty('conversationId');
  expect(item).toMatchObject({ sourceDeleted: true });
});

it('memory.list pages newest first', async () => {
  const { asOwner, asAgent } = await setup();
  vi.useFakeTimers({ toFake: ['Date'] });
  for (let index = 0; index < 32; index++) {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, index)));
    await asOwner('memory.add', { kind: 'other', text: `Synthetic note ${index}` });
  }
  const first = await asAgent('memory.list', {});
  expect(first.data.items).toHaveLength(30);
  expect(first.data.items[0].text).toBe('Synthetic note 31');
  const second = await asAgent('memory.list', { cursor: first.data.nextCursor });
  expect(second.data.items.map((item: any) => item.text)).toEqual(['Synthetic note 1', 'Synthetic note 0']);
  expect(second.data).not.toHaveProperty('nextCursor');
});

it('Agent cannot delete: memory.delete, memory.edit and memory.add through MCP are refused and memories are unchanged', async () => {
  const { host, asAgent } = await setup();
  const { data } = await asAgent('memory.record', { kind: 'habit', text: 'Skips lectures' }, 'v-1');
  for (const name of ['memory.add', 'memory.edit', 'memory.delete']) expect(ownerCommands.has(name)).toBe(true);
  const server = createMcpServer({ registry: host.registry, context: { ...host.context, owner }, stderr: () => {} });
  const client = new Client({ name: 'synthetic-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['memory.record', 'memory.list']));
  const before = host.store.listMemories();
  for (const [name, args] of [['memory.delete', { id: data.id }], ['memory.edit', { id: data.id, text: 'Changed' }], ['memory.add', { kind: 'other', text: 'Planted' }]] as const) {
    expect(names).not.toContain(name);
    const result = await client.callTool({ name, arguments: args });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ ok: false });
  }
  expect(host.store.listMemories()).toEqual(before);
});

it('chat backend attributes memory.record through the scope of every supplied tool', async () => {
  const { host, list } = await setup();
  const adapter = { id: 'synthetic', start: (input: import('../../src/agent/adapter.js').AgentInput) => ({
    async *[Symbol.asyncIterator]() {
      const tool = input.tools.find(tool => tool.name === 'memory.record')!;
      expect(await tool.execute({ kind: 'habit', text: 'Scoped observation' })).toMatchObject({ ok: true });
      yield { type: 'result' as const, turns: 1 };
    }, interrupt() {},
  }) };
  const composed = createProductionProtocol({ store: host.store, agentAdapter: adapter }); closers.push(() => composed.close());
  const c = await composed.chat.create({}, owner);
  await composed.chat.send(c.id, 'Synthetic request', owner); await composed.chat.waitForIdle(c.id);
  expect((await list())[0]).toMatchObject({ conversationId: c.id, text: 'Scoped observation' });
});

it('retains personal details in agent record, owner add and edit', async () => {
  const { asAgent, asOwner, host } = await setup();
  const recorded = await asAgent('memory.record', { kind: 'habit', text: 'Studies with Jane Example' });
  expect(recorded).toMatchObject({ ok: true });
  expect(host.store.loadMemory(recorded.data.id)!.text).toBe('Studies with Jane Example');
  const added = await asOwner('memory.add', { kind: 'other', text: 'Reviews with Jane Example' });
  expect(added).toMatchObject({ ok: true });
  expect(host.store.loadMemory(added.data.id)!.text).toBe('Reviews with Jane Example');
  expect(await asOwner('memory.edit', { id: added.data.id, text: 'Practises with Jane Example' })).toMatchObject({ ok: true });
  expect(host.store.loadMemory(added.data.id)!.text).toBe('Practises with Jane Example');

});

it('passes stored personal details to the brief delivered to the chat adapter', async () => {
  const briefs: string[] = [];
  const { host } = await setup({ agentAdapter: { id: 'synthetic', start(input) {
      briefs.push(input.brief!);
      return { async *[Symbol.asyncIterator]() { yield { type: 'result' as const, turns: 1 }; }, interrupt() {} };
    } } });
  host.store.saveAssessment({ id: 'private-title', courseId: 'c-1', name: 'Review with Jane Example', isFinal: false, status: 'graded', score: 80 });
  const c = await host.chat.create({ courseId: 'c-1' }, owner);
  await host.chat.send(c.id, 'Synthetic request', owner); await host.chat.waitForIdle(c.id);
  expect(briefs).toHaveLength(1);
  expect(briefs[0]).toContain('Review with Jane Example');
});


it('#191 returns stored classmate details and owner memory unchanged', async () => {
  const { host, asAgent, asOwner, list } = await setup();
  const text = 'Synthetic Person synthetic@example.invalid';
  host.store.saveCourse({ ...host.store.loadCourse('c-1')!, name: text });
  const memory = await asOwner('memory.add', { kind: 'other', text });
  expect(await asAgent('courses.list', {})).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ name: text })] } });
  expect(memory).toMatchObject({ ok: true });
  expect(host.store.loadMemory(memory.data.id)!.text).toBe(text);
  expect(await list()).toEqual([expect.objectContaining({ text })]);
  expect(collectBrief(host.store, {})).toContain(text);
});


it('CLI and MCP return stored classmate details unchanged (#191)', async () => {
  const { host } = await setup();
  const text = 'Synthetic Person synthetic@example.invalid';
  host.store.saveCourse({ ...host.store.loadCourse('c-1')!, name: text });
  const output: string[] = [];
  await parseProtocolCLI(['courses', 'list', '--json'], { registry: host.registry, context: host.context,
    stdout: line => output.push(line), stderr: () => {} });
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ name: text })] } });
  const server = createMcpServer({ registry: host.registry, context: host.context, stderr: () => {} });
  const client = new Client({ name: 'synthetic-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closers.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const result = await client.callTool({ name: 'courses.list', arguments: {} });
  expect(JSON.parse((result.content as { text: string }[])[0]!.text))
    .toMatchObject({ ok: true, data: { items: [expect.objectContaining({ name: text })] } });
});
