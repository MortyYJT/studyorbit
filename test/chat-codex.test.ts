import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', async original => ({ ...(await original<typeof import('node:child_process')>()), spawn: (...args: unknown[]) => spawnMock(...args) }));
const { chat } = await import('../scripts/lib/llm-providers.mjs');

type FakeProcess = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number; prompt: Promise<string> };
function fakeProcess(lines: unknown[], exitCode = 0): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough(); proc.pid = 0;
  let prompt = '';
  proc.prompt = new Promise(resolve => { proc.stdin.on('data', chunk => { prompt += chunk; }); proc.stdin.on('finish', () => resolve(prompt)); });
  setTimeout(() => {
    for (const line of lines) proc.stdout.write(`${JSON.stringify(line)}\n`);
    proc.stdout.end();
    setTimeout(() => proc.emit('close', exitCode), 5);
  }, 5);
  return proc;
}

afterEach(() => { spawnMock.mockReset(); });

describe('chat with codex', () => {
  const config = { provider: 'codex' as const, model: 'gpt-6-luna', baseUrl: null, apiKey: null };
  const input = { system: 'SYSTEM PROMPT', messages: [{ role: 'user' as const, content: 'Explain recursion' }] };

  it('runs codex exec read-only without sub-agents and emits the final message once', async () => {
    const proc = fakeProcess([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Recursion is…' } },
      { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 6 } },
    ]);
    spawnMock.mockReturnValue(proc);
    const deltas: string[] = [];
    const result = await chat(config, input, { onDelta: text => deltas.push(text) });
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--sandbox', 'read-only', '-c', 'agents.enabled=false', '-m', 'gpt-6-luna']));
    const prompt = await proc.prompt;
    expect(prompt).toContain('SYSTEM PROMPT');
    expect(prompt).toContain('Explain recursion');
    expect(deltas).toEqual(['Recursion is…']);
    expect(result).toMatchObject({ ok: true, text: 'Recursion is…', usage: { input: 20, cached: 5, output: 6 } });
  });

  it('reports a failed turn', async () => {
    spawnMock.mockReturnValue(fakeProcess([{ type: 'turn.failed', error: { message: 'boom' } }], 1));
    const result = await chat(config, input, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
