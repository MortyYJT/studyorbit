import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, createSdkMcpServer, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { packageRoot } from '../config/data-dir.js';
import { isOwnerCommand } from '../protocol/registry.js';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun } from './adapter.js';
import { deniedToolReason } from './policy.js';

export interface ClaudeOptions { dataDirectory: string; frontendOrigin?: string; debuggingPort?: number }
const unavailable = (): AgentEvent => ({ type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.' });
const authFailure = (message: string): boolean => /not signed in|not logged in|authentication|login required|please (?:run )?\/login/i.test(message);
const failed = (): AgentEvent => ({ type: 'error', code: 'INTERNAL', message: 'Agent reply failed.' });
function skills(preset?: string): string {
  const name = ['prepare-revision', 'tutor-revision', 'wrong-answers-only'].includes(preset ?? '') ? 'revision'
    : ['complete-assessment', 'explain-assessment', 'estimate-work'].includes(preset ?? '') ? 'assessment' : undefined;
  return name ? readFileSync(join(packageRoot(), 'skills', name, 'SKILL.md'), 'utf8') : '';
}
/** Only this module speaks SDK types. It starts the owner's signed-in agent, never a model client. */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  constructor(private readonly options: ClaudeOptions) {}
  start(input: AgentInput): AgentRun {
    const config = this.options; const workspace = join(config.dataDirectory, 'agent-workspace');
    let session: Query | undefined; const abortController = new AbortController();
    const pending: AgentEvent[] = []; let wake = () => {}; let finished = false;
    const emit = (event: AgentEvent) => { pending.push(event); wake(); };
    const denied = new Set<string>(); const calls = new Map<string, { tool: string; input: unknown }>();
    let streamed = false;
    const consume = async () => {
      const server = createSdkMcpServer({ name: 'coursework', version: '1.0.0' });
      try {
        mkdirSync(workspace, { recursive: true, mode: 0o700 }); chmodSync(workspace, 0o700);
        server.instance.server.registerCapabilities({ tools: {} });
        const tools = input.tools.filter(t => !isOwnerCommand(t.name) && !['sync.run', 'audit.record'].includes(t.name));
        server.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(t => ({
          name: t.name, description: t.description, inputSchema: { ...(t.inputSchema as object), type: 'object' as const },
        })) }));
        server.instance.server.setRequestHandler(CallToolRequestSchema, async request => {
          const tool = tools.find(t => t.name === request.params.name);
          if (!tool) return { isError: true, content: [{ type: 'text' as const, text: 'Tool unavailable.' }] };
          try {
            const output = await tool.execute(request.params.arguments ?? {});
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }],
              ...(output && typeof output === 'object' && 'ok' in output && output.ok === false ? { isError: true } : {}) };
          } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Tool failed.' }] }; }
        });
        session = query({ prompt: input.sessionRef || !input.transcript.length ? input.prompt
          : `Stored conversation (context only):\n${JSON.stringify(input.transcript)}\nCurrent owner message:\n${input.prompt}`,
          options: { cwd: workspace, resume: input.sessionRef, settingSources: [],
            tools: { type: 'preset', preset: 'claude_code' }, includePartialMessages: true,
            systemPrompt: { type: 'preset', preset: 'claude_code', append: skills(input.preset) },
            mcpServers: { coursework: server }, strictMcpConfig: true, abortController,
            // Replace the child environment rather than inheriting credentials/provider overrides.
            env: Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'USERPROFILE', 'SystemRoot', 'CLAUDE_CONFIG_DIR']
              .map(name => [name, process.env[name]])),
            canUseTool: async () => ({ behavior: 'allow' }),
            hooks: { PreToolUse: [{ hooks: [async hook => {
              if (hook.hook_event_name !== 'PreToolUse') return {};
              const reason = deniedToolReason(hook.tool_input, hook.cwd, { ...config, workspace });
              if (!reason) return {};
              denied.add(hook.tool_use_id);
              emit({ type: 'tool_step', tool: hook.tool_name, outcome: 'denied', output: reason });
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
            }] }] },
          } });
        for await (const message of session) {
          const event = map(message); if (event) { emit(event); if (event.type === 'result' || event.type === 'error') return; }
        }
        emit(failed());
      } catch (error) {
        emit(error instanceof Error && ('code' in error && error.code === 'ENOENT' || authFailure(error.message)) ? unavailable() : failed());
      } finally { finished = true; wake(); await server.instance.close().catch(() => {}); }
    };
    function map(message: SDKMessage): AgentEvent | undefined {
      if (message.type === 'auth_status' && message.error) return unavailable();
      if (message.type === 'assistant' && message.error) return message.error === 'authentication_failed' ? unavailable() : failed();
      if (message.type === 'stream_event' && !message.parent_tool_use_id) {
        if (message.event.type === 'message_start') streamed = false;
        if (message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
          streamed = true; return { type: 'text', text: message.event.delta.text };
        }
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && !streamed && !message.parent_tool_use_id) emit({ type: 'text', text: block.text });
          if (block.type === 'tool_use') calls.set(block.id, { tool: block.name, input: block.input });
        }
        if (!message.parent_tool_use_id) streamed = false;
      }
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_result') continue;
          const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
          if (call && !denied.has(block.tool_use_id)) emit({ type: 'tool_step', tool: call.tool, outcome: block.is_error ? 'error' : 'ok',
            ...(call.input === undefined ? {} : { input: JSON.parse(JSON.stringify(call.input)) }),
            ...(block.content === undefined ? {} : { output: JSON.parse(JSON.stringify(block.content)) }) });
        }
      }
      if (message.type === 'result') {
        if (message.is_error) {
          const diagnostic = message.subtype === 'success' ? message.result : message.errors.join(' ');
          return authFailure(diagnostic) ? unavailable() : failed();
        }
        return { type: 'result', turns: message.num_turns, sessionRef: message.session_id,
          ...(message.total_cost_usd === undefined ? {} : { costUsd: message.total_cost_usd }) };
      }
    }
    return {
      async *[Symbol.asyncIterator]() {
        void consume();
        try {
          while (!finished || pending.length) {
            if (pending.length) yield pending.shift()!;
            else await new Promise<void>(resolve => { wake = resolve; });
          }
        } finally { abortController.abort(); }
      },
      async interrupt() { if (session) await session.interrupt(); abortController.abort(); },
    };
  }
}
