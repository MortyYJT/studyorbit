import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { envelopeSchema, ownerCommands } from '../../src/protocol/contracts.js';
import { Registry, createRegistry, isOwnerCommand } from '../../src/protocol/registry.js';
import { createFakeContext, examples, FakeServices } from '../../src/protocol/fakes.js';
import { createMcpServer, runMcpStdio } from '../../src/protocol/mcp.js';
import type { TrustedContext } from '../../src/protocol/context.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function connect(registry: Registry, context: TrustedContext, stderr: (line: string) => void = () => {}) {
  const server = createMcpServer({ registry, context, stderr });
  const client = new Client({ name: 'synthetic-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { client, server };
}
function envelope(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return { text: content[0]!.text, body: JSON.parse(content[0]!.text) as Record<string, any> };
}

it('initializes through the official SDK and advertises the tools capability', async () => {
  const { client } = await connect(createRegistry(), createFakeContext());
  expect(client.getServerVersion()).toMatchObject({ name: 'coursework' });
  expect(client.getServerCapabilities()).toHaveProperty('tools');
});

it('discovers the registry minus owner-only commands, with zod-derived object input schemas (decision #87)', async () => {
  const registry = createRegistry();
  const { client } = await connect(registry, createFakeContext());
  const { tools } = await client.listTools();
  expect(tools.map(tool => tool.name).sort())
    .toEqual(registry.list().map(entry => entry.name).filter(name => !isOwnerCommand(name) && !['audit.record', 'sync.run'].includes(name)).sort());
  expect(tools.some(tool => ownerCommands.has(tool.name))).toBe(false);
  for (const tool of tools) {
    const entry = registry.get(tool.name)!;
    const derived = z.toJSONSchema(entry.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    expect(tool.inputSchema.type).toBe('object');
    if (derived.properties) expect(tool.inputSchema.properties).toEqual(derived.properties);
    else expect(tool.inputSchema.oneOf ?? tool.inputSchema.anyOf).toEqual(derived.oneOf ?? derived.anyOf);
  }
});

it('calls a registry command through dispatch and returns one contract envelope', async () => {
  const context = createFakeContext();
  const { client } = await connect(createRegistry(), context);
  const result = await client.callTool({ name: 'courses.list', arguments: examples['courses.list'].input });
  const { body } = envelope(result);
  expect(result.isError).toBeFalsy();
  expect(envelopeSchema('courses.list').parse(body)).toMatchObject({ ok: true, data: examples['courses.list'].output });
  expect(context.events.map(event => event.phase)).toEqual(['intent', 'outcome']);
});

it('runtime zod refinements reject input the advertised schema cannot express, without executing', async () => {
  const context = createFakeContext();
  const { client } = await connect(createRegistry(), context);
  const input = structuredClone(examples['breakdown.write'].input);
  input.assessmentId = 'another-assessment';
  const result = await client.callTool({ name: 'breakdown.write', arguments: input });
  const { body, text } = envelope(result);
  expect(result.isError).toBe(true);
  expect(body).toMatchObject({ ok: false, command: 'breakdown.write', error: { code: 'INVALID_INPUT' } });
  expect(text).not.toContain('another-assessment');
  expect((context.services as FakeServices).writes).toHaveLength(0);
  expect(context.events.map(event => event.phase)).toEqual(['denial']);
});

it('dispatches each tool call exactly once with the host context', async () => {
  const registry = new Registry(); const seen: unknown[] = [];
  const context = createFakeContext();
  registry.register({ name: 'synthetic.echo', level: 0, input: z.strictObject({ value: z.number() }),
    output: z.strictObject({ value: z.number() }), handler: (input, ctx) => { seen.push(ctx.repository); return input; } });
  const { client } = await connect(registry, context);
  const { body } = envelope(await client.callTool({ name: 'synthetic.echo', arguments: { value: 3 } }));
  expect(body).toMatchObject({ ok: true, data: { value: 3 } });
  expect(seen).toEqual([context.repository]);
  expect(context.events).toHaveLength(2);
});

it('unknown tools and thrown handler errors return sanitized envelopes without echoing input', async () => {
  const registry = new Registry();
  registry.register({ name: 'synthetic.fail', level: 0, input: z.strictObject({ value: z.string() }), output: z.null(),
    handler: () => { throw new Error('raw failure at /private/synthetic/path'); } });
  const { client } = await connect(registry, createFakeContext());
  const missing = envelope(await client.callTool({ name: 'secret.prose.tool', arguments: { value: 'echo-me' } }));
  expect(missing.body).toMatchObject({ ok: false, command: 'unknown', error: { code: 'NOT_FOUND' } });
  expect(missing.text).not.toContain('secret.prose'); expect(missing.text).not.toContain('echo-me');
  const failed = envelope(await client.callTool({ name: 'synthetic.fail', arguments: { value: 'echo-me' } }));
  expect(failed.body).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(failed.text).not.toContain('/private/synthetic'); expect(failed.text).not.toContain('echo-me');
});

it('keeps tool results within the 64 KiB command-envelope bound', async () => {
  const registry = new Registry();
  registry.register({ name: 'synthetic.big', level: 0, input: z.strictObject({}), output: z.string(),
    handler: () => 'word '.repeat(20000) });
  const { client } = await connect(registry, createFakeContext());
  const { body, text } = envelope(await client.callTool({ name: 'synthetic.big', arguments: {} }));
  expect(body).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
});

it.each(['policy.record', 'grant.record'] as const)(
  'owner command %s is refused even with a host owner capability and forged owner arguments', async name => {
    let ownerCalls = 0;
    const context = { ...createFakeContext(), owner: { assertOwner: async () => { ownerCalls++; } } };
    const { client } = await connect(createRegistry(), context);
    for (const args of [examples[name].input, { ...examples[name].input, owner: true }]) {
      const { body } = envelope(await client.callTool({ name, arguments: args as Record<string, unknown> }));
      expect(body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    expect(ownerCalls).toBe(0);
    expect((context.services as FakeServices).writes).toHaveLength(0);
  });

it('stdio framing: stdout carries only JSON-RPC lines, diagnostics go to stderr, end of input closes cleanly', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const diagnostics: string[] = [];
  let out = ''; stdout.on('data', chunk => { out += String(chunk); });
  const closed = runMcpStdio({ registry: createRegistry(), context: createFakeContext(), stdin, stdout,
    stderr: line => diagnostics.push(line) });
  const send = (message: object) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const waitFor = async (id: number) => {
    for (let attempt = 0; attempt < 200 && !out.split('\n').some(line => line.includes(`"id":${id}`)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '0' } } });
  await waitFor(1);
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'courses.list', arguments: { limit: 'not-a-number' } } });
  await waitFor(2);
  stdin.end();
  await expect(closed).resolves.toBeUndefined();
  const lines = out.split('\n').filter(Boolean);
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  const call = JSON.parse(lines[1]!);
  expect(JSON.parse(call.result.content[0].text)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics.join('\n')).not.toContain('not-a-number');
});

it('browser.status is L0 over MCP and returns one safe per-site result without lifecycle tools', async () => {
  const status = { canvas: { state: 'signedOut' as const, checkedAt: '2026-01-01T00:00:00.000Z',
    hint: { code: 'AUTH_EXPIRED' as const, next: 'Sign in to Canvas by hand in the resident browser.' as const } },
    ed: { state: 'signedIn' as const, checkedAt: '2026-01-01T00:00:00.000Z' } };
  const { client } = await connect(createRegistry({ browser: { status: async () => status } }), createFakeContext());
  const tools = (await client.listTools()).tools;
  expect(tools.find(tool => tool.name === 'browser.status')).toBeDefined();
  expect(tools.some(tool => ['browser.start', 'browser.stop'].includes(tool.name))).toBe(false);
  const result = envelope(await client.callTool({ name: 'browser.status', arguments: {} }));
  expect(result.body).toMatchObject({ ok: true, command: 'browser.status', data: status });
  expect(result.text).not.toMatch(/endpoint|cookies|token|body/);
});

it('audit.record is neither advertised nor callable over MCP and cannot attest an action', async () => {
  const context = createFakeContext({ owner: true });
  const { client } = await connect(createRegistry(), context);
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('audit.record');
  const { body } = envelope(await client.callTool({ name: 'audit.record', arguments: { assessmentId: 'd', action: 'submit', outcome: 'success', confirmation: 'owner-ui' } }));
  expect(body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(context.events.some(event => event.action || event.confirmation)).toBe(false);
});
