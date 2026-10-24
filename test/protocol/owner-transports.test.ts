import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/protocol/mcp.js';
import { Registry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { httpCommandContext } from '../../src/protocol/http.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
const names = ['policy.record', 'grant.record', 'annotation.owner.record', 'planning.settings.record'];
function setup() {
  const registry = new Registry(); const handler = vi.fn(async () => ({}));
  for (const name of names) registry.register({ name, input: z.strictObject({}), output: z.strictObject({}), level: 0, handler });
  return { registry, handler, context: createFakeContext({ owner: true }) };
}
it('HTTP session grants owner commands and refuses unauthenticated requests', async () => {
  const { registry, handler, context } = setup();
  for (const name of names) {
    const result = await dispatch(registry, name, {}, httpCommandContext(context, name, true, () => false));
    expect(result.ok).toBe(true);
  }
  expect(handler).toHaveBeenCalledTimes(names.length);
  expect(await dispatch(registry, 'planning.settings.record', {}, httpCommandContext(context, 'planning.settings.record', false, () => false))).toMatchObject({ ok: false });
});
it('all current and reserved owner commands refuse non-TTY CLI and print exactly once', async () => {
  const { registry, handler, context } = setup();
  for (const name of names) {
    const stdout: string[] = [];
    await parseProtocolCLI(name.split('.'), { registry, context, isTTY: false, stdout: s => stdout.push(s), stderr: () => {} });
    expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false });
  }
  expect(handler).not.toHaveBeenCalled();
});
it('MCP hides and refuses every owner command despite a host owner capability', async () => {
  const { registry, handler, context } = setup(); const server = createMcpServer({ registry, context, stderr: () => {} });
  const client = new Client({ name: 'synthetic', version: '0' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b); await client.connect(a);
    expect((await client.listTools()).tools).toEqual([]);
    for (const name of names) expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});
