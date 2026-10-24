import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { dispatch, type Registry, type RegistryEntry } from './registry.js';
import type { TrustedContext } from './context.js';
import { ownerCommands } from './contracts.js';
import { fail, type Envelope } from './envelope.js';
import { MAX_INPUT_BYTES } from './cli.js';

export interface McpOptions {
  registry: Registry; context: TrustedContext;
  /** Diagnostics sink; never stdout, which carries only MCP framing. */
  stderr?: (line: string) => void;
  /** Reported in the MCP initialize result. */
  version?: string;
}
export interface McpStdioOptions extends McpOptions { stdin?: Readable; stdout?: Writable }

/** Advertise the zod contract as JSON Schema; MCP requires an object root, so unions are wrapped. */
export function inputSchema(entry: RegistryEntry): Tool['inputSchema'] {
  const { $schema: _schema, ...schema } = z.toJSONSchema(entry.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...schema, type: 'object' } as Tool['inputSchema'];
}
export function describe(entry: RegistryEntry): string {
  return ownerCommands.has(entry.name)
    ? `${entry.name} (L${entry.level}; owner terminal only, always refused over MCP)`
    : `${entry.name} (L${entry.level}); returns one coursework.agent/v1 envelope`;
}
function toResult(envelope: Envelope): CallToolResult {
  // The envelope is already bounded to 64 KiB by the dispatcher's serialization checks.
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: !envelope.ok };
}

/**
 * Build an official SDK server whose tools are generated from the registry. Every call goes through
 * dispatch() once; runtime zod validation, authorization and output bounds stay in the dispatcher.
 */
export function createMcpServer(options: McpOptions): McpServer {
  const stderr = options.stderr ?? (line => process.stderr.write(`${line}\n`));
  // Host-owned context without owner authority: MCP arguments can never establish an owner.
  const { registry, context } = options.registry.agentTools(options.context);
  // The Codex profile (set only in Codex's MCP entry) hides our resident-browser tools; Codex uses its own computer use.
  const hidden = (name: string) => process.env.COURSEWORK_MCP_PROFILE === 'codex' && name.startsWith('browser.');
  const server = new McpServer({ name: 'coursework', version: options.version ?? '0.0.0' }, { capabilities: { tools: {} } });
  // Low-level handlers keep advertised schemas derived from zod while leaving validation to dispatch().
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    // Decision #87: agents never see owner-only tools; calling one by name is still refused below.
    tools: registry.list().filter(entry => !hidden(entry.name)).map(entry => ({ name: entry.name, description: describe(entry), inputSchema: inputSchema(entry) })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    let envelope: Envelope;
    try {
      envelope = hidden(request.params.name) ? fail('unknown', 'NOT_FOUND', 'The command or requested record was not found.')
        : await dispatch(registry, request.params.name, request.params.arguments ?? {}, context);
    } catch {
      envelope = fail('unknown', 'INTERNAL', 'The command could not complete safely.');
    }
    if (!envelope.ok) stderr(`coursework mcp: command failed: ${envelope.error.code}.`);
    return toResult(envelope);
  });
  server.server.onerror = () => { stderr('coursework mcp: transport error.'); };
  return server;
}

/** Serve over stdio until the client disconnects (input ends) and the server has closed. */
export async function runMcpStdio(options: McpStdioOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin; const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? (line => process.stderr.write(`${line}\n`));
  const server = createMcpServer({ ...options, stderr });
  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: MAX_INPUT_BYTES });
  const closed = new Promise<void>(resolve => { server.server.onclose = () => resolve(); });
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    server.close().catch(() => { stderr('coursework mcp: shutdown error.'); });
  };
  stdin.once('end', shutdown); stdin.once('close', shutdown);
  stdout.on('error', () => { stderr('coursework mcp: output closed.'); shutdown(); });
  await server.connect(transport);
  stderr(`coursework mcp: serving ${options.registry.list().length} tools over stdio.`);
  await closed;
  stderr('coursework mcp: disconnected.');
}
