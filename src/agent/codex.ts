import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { packageRoot } from '../config/data-dir.js';
import type { AgentAdapter, AgentEvent, AgentInput, AgentRun } from './adapter.js';
import { presetSkill } from './presets.js';

export interface CodexOptions { dataDirectory: string; killAfterMs?: number }
type Failure = Extract<AgentEvent, { type: 'error' }>;
interface Attempt { threadId?: string; turns: number; emitted: number; code: number | null; missing: boolean; turnFailed: boolean; auth: boolean }
const unavailable = (): Failure => ({ type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.' });
const failed = (turns = 0): Failure => ({ type: 'error', code: 'INTERNAL', message: 'Agent reply failed.', ...(turns ? { turns } : {}) });
const authFailure = (text: string) => /not (?:signed|logged) in|login required|authentication/i.test(text);
/** Outside any Git working tree, so no repository AGENTS.md applies; one per data directory. */
export function codexWorkspace(dataDirectory: string): string {
  return join(homedir(), '.coursework', 'codex-workspace', createHash('sha256').update(resolve(dataDirectory)).digest('hex').slice(0, 12));
}
/** Map one JSONL line. Only names and outcomes are kept: arguments, results and command output can carry page text. */
function parse(line: string, state: Attempt): AgentEvent | undefined {
  let event: Record<string, any>;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== 'object') return;
  if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) state.threadId = event.thread_id;
  if (event.type === 'turn.completed') state.turns++;
  if (event.type === 'turn.failed') state.turnFailed = true;
  if ((event.type === 'turn.failed' || event.type === 'error') && authFailure(String(event.error?.message ?? event.message ?? ''))) state.auth = true;
  const item = event.type === 'item.completed' && event.item && typeof event.item === 'object' ? event.item as Record<string, any> : undefined;
  if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text) return { type: 'text', text: item.text };
  if (item?.type === 'mcp_tool_call' && typeof item.server === 'string' && item.server && typeof item.tool === 'string' && item.tool) {
    return { type: 'tool_step', tool: item.server === 'cua_repl' ? 'computer' : `${item.server}.${item.tool}`, outcome: item.status === 'completed' && !item.error ? 'ok' : 'error' };
  }
  if (item?.type === 'command_execution') return { type: 'tool_step', tool: 'shell', outcome: item.status === 'completed' && item.exit_code === 0 ? 'ok' : 'error' };
}
/** Starts the owner's signed-in `codex` CLI per reply; never a model client, never its sandbox or approval bypass. */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  constructor(private readonly options: CodexOptions) {}
  start(input: AgentInput): AgentRun {
    const { dataDirectory, killAfterMs = 3000 } = this.options;
    const workspace = codexWorkspace(dataDirectory);
    let child: ChildProcess | undefined; let stopped = false;
    const stop = () => {
      const running = child;
      if (!running || running.exitCode !== null || running.signalCode !== null) return;
      running.kill('SIGTERM');
      const timer = setTimeout(() => running.kill('SIGKILL'), killAfterMs);
      running.once('close', () => clearTimeout(timer));
    };
    // `codex exec resume` rejects -C and -s, so the sandbox is set by config and the workspace by the child's cwd.
    const common = ['--json', '--skip-git-repo-check', ...[
      'sandbox_mode="workspace-write"',
      `mcp_servers.coursework.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.coursework.args=${JSON.stringify([join(packageRoot(), 'dist', 'cli.js'), 'mcp'])}`,
      'mcp_servers.coursework.env.COURSEWORK_MCP_PROFILE="codex"',
      `mcp_servers.coursework.env.COURSEWORK_HOME=${JSON.stringify(resolve(dataDirectory))}`,
      // Without pre-approval `codex exec` refuses every MCP call.
      'mcp_servers.coursework.default_tools_approval_mode="approve"',
    ].flatMap(value => ['-c', value])];
    const skill = presetSkill(input.preset);
    const withSkill = (text: string) => skill ? `${skill}\n\n${text}` : text;
    async function* attempt(args: string[], prompt: string): AsyncGenerator<AgentEvent, Attempt> {
      const state: Attempt = { turns: 0, emitted: 0, code: null, missing: false, turnFailed: false, auth: false };
      if (stopped) return state;
      const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'CODEX_HOME'].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
      const proc = spawn('codex', args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
      child = proc;
      // Diagnostics stay in memory for classification only; raw output is never stored or logged.
      let diagnostics = '';
      proc.stderr.setEncoding('utf8'); proc.stderr.on('data', (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-8192); });
      const exited = new Promise<void>(done => {
        proc.on('error', (error: NodeJS.ErrnoException) => { if (state.code === null) state.missing ||= error.code === 'ENOENT'; done(); });
        proc.once('close', code => { state.code = code; done(); });
      });
      proc.stdin.on('error', () => {}); proc.stdin.end(prompt);
      for await (const line of createInterface({ input: proc.stdout, crlfDelay: Infinity })) {
        const event = parse(line, state);
        if (event) { state.emitted++; yield event; }
      }
      await exited;
      state.auth ||= authFailure(diagnostics);
      return state;
    }
    return {
      async *[Symbol.asyncIterator]() {
        try {
          mkdirSync(workspace, { recursive: true, mode: 0o700 }); chmodSync(workspace, 0o700);
          writeFileSync(join(workspace, 'AGENTS.md'), readFileSync(join(packageRoot(), 'src', 'agent', 'codex-instructions.md'), 'utf8'), { mode: 0o600 });
          let outcome: Attempt | undefined;
          if (input.sessionRef) outcome = yield* attempt(['exec', 'resume', input.sessionRef, ...common, '-'], withSkill(input.prompt));
          // The stored transcript is the memory (#177): a resume that fails before any output continues in a new thread.
          if (!outcome || !outcome.missing && !outcome.auth && (outcome.code !== 0 || outcome.turnFailed) && !outcome.emitted) {
            outcome = yield* attempt(['exec', ...common, '-'], withSkill(input.transcript.length
              ? `Stored conversation (context only):\n${JSON.stringify(input.transcript)}\nCurrent owner message:\n${input.prompt}` : input.prompt));
          }
          if (stopped) return;
          if (outcome.missing || outcome.auth) yield unavailable();
          else if (outcome.code !== 0 || outcome.turnFailed) yield failed(outcome.turns);
          else yield { type: 'result', turns: outcome.turns, ...(outcome.threadId ? { sessionRef: outcome.threadId } : {}) };
        } catch { if (!stopped) yield failed(); } finally { stop(); }
      },
      interrupt() { stopped = true; stop(); },
    };
  }
}
