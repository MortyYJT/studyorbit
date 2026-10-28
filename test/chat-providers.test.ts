import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChatRequest, chat } from '../scripts/lib/llm-providers.mjs';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';

afterEach(() => { vi.unstubAllGlobals(); });

/** A streamed response whose body yields the given raw SSE chunks, optionally waiting before each. */
function stream(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) { controller.enqueue(encoder.encode(chunk)); await new Promise(resolve => setTimeout(resolve, 1)); }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' }, ...init });
}
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const input = { system: 'SYSTEM PROMPT', messages: [{ role: 'user' as const, content: 'Hi' }, { role: 'assistant' as const, content: 'Hello' }, { role: 'user' as const, content: 'Plan my week' }] };
const deepseek: AnalysisConfig = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, apiKey: 'sk-test-ds' };
const compatible: AnalysisConfig = { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'https://llm.example/v1/chat/completions', apiKey: 'sk-test-oc' };
const anthropic: AnalysisConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, apiKey: 'sk-test-an' };

describe('buildChatRequest', () => {
  it('builds a streaming DeepSeek Responses request with instructions and the conversation', () => {
    const request = buildChatRequest(deepseek, input);
    expect(request.url).toBe('https://api.deepseek.com/responses');
    expect(request.headers.Authorization).toBe('Bearer sk-test-ds');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ model: 'deepseek-flash', stream: true, instructions: 'SYSTEM PROMPT' });
    expect(body.input).toEqual(input.messages);
    expect(request.body).not.toContain('sk-test-ds');
  });

  it('builds a streaming chat-completions request with a system message for openai-compatible', () => {
    const request = buildChatRequest(compatible, input);
    expect(request.url).toBe(compatible.baseUrl);
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ model: 'synthetic-model', stream: true, stream_options: { include_usage: true } });
    expect(body.messages).toEqual([{ role: 'system', content: 'SYSTEM PROMPT' }, ...input.messages]);
  });

  it('builds a streaming Messages request with a cached system block for anthropic', () => {
    const request = buildChatRequest(anthropic, input);
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['x-api-key']).toBe('sk-test-an');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, messages: input.messages });
    expect(body.system).toEqual([{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }]);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.thinking).toBeUndefined();
  });

  it('drops leading assistant messages so the conversation starts with the user', () => {
    const body = JSON.parse(buildChatRequest(anthropic, { system: 's', messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }] }).body);
    expect(body.messages).toEqual([{ role: 'user', content: 'y' }]);
  });
});

describe('chat streaming with a mocked fetch', () => {
  it('assembles DeepSeek Responses deltas and usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      data({ type: 'response.created', response: { status: 'in_progress' } }),
      data({ type: 'response.output_text.delta', delta: '先做' }), data({ type: 'response.output_text.delta', delta: ' A2。' }),
      data({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 4 } } }),
    ])));
    const deltas: string[] = [];
    const result = await chat(deepseek, input, { onDelta: text => deltas.push(text) });
    expect(deltas).toEqual(['先做', ' A2。']);
    expect(result).toMatchObject({ ok: true, text: '先做 A2。', model: 'deepseek-flash', usage: { input: 12, output: 4 } });
  });

  it('reports a DeepSeek failure event and keeps partial text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      data({ type: 'response.output_text.delta', delta: 'partial' }),
      data({ type: 'response.failed', response: { status: 'failed', error: { message: 'overloaded sk-test-ds' } } }),
    ])));
    const result = await chat(deepseek, input, {});
    expect(result.ok).toBe(false);
    expect(result.text).toBe('partial');
    expect(result.error).toContain('overloaded');
    expect(result.error).not.toContain('sk-test-ds');
  });

  it('assembles openai-compatible chunks split across reads, including CRLF and [DONE]', async () => {
    const first = data({ choices: [{ delta: { role: 'assistant', content: 'Hel' } }] });
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      first.slice(0, 10), first.slice(10).replace('\n\n', '\r\n\r\n'),
      data({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
      data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ])));
    const deltas: string[] = [];
    const result = await chat(compatible, input, { onDelta: text => deltas.push(text) });
    expect(deltas.join('')).toBe('Hello');
    expect(result).toMatchObject({ ok: true, text: 'Hello', usage: { input: 7, output: 2 } });
  });

  it('treats an openai-compatible stream that ends without a finish reason as interrupted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([data({ choices: [{ delta: { content: 'Half' } }] })])));
    const result = await chat(compatible, input, {});
    expect(result).toMatchObject({ ok: false, text: 'Half' });
    expect(result.error).toBeTruthy();
  });

  it('assembles Anthropic text deltas, ignores thinking deltas and folds cache usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      'event: message_start\n' + data({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 1 } } }),
      data({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }),
      data({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Revise ' } }),
      data({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'week 9.' } }),
      data({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      data({ type: 'message_stop' }),
    ])));
    const deltas: string[] = [];
    const result = await chat(anthropic, input, { onDelta: text => deltas.push(text) });
    expect(deltas).toEqual(['Revise ', 'week 9.']);
    expect(result).toMatchObject({ ok: true, text: 'Revise week 9.', usage: { input: 103, cached: 100, output: 9 } });
  });

  it('reports an Anthropic error event and a refusal stop reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      data({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ])));
    expect(await chat(anthropic, input, {})).toMatchObject({ ok: false, error: expect.stringContaining('Overloaded') });
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      data({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      data({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }),
    ])));
    expect(await chat(anthropic, input, {})).toMatchObject({ ok: false, error: expect.stringContaining('拒绝') });
  });

  it('treats an Anthropic stream that ends early as interrupted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      data({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Par' } }),
    ])));
    expect(await chat(anthropic, input, {})).toMatchObject({ ok: false, text: 'Par', error: expect.any(String) });
  });

  it('reports an HTTP error with the provider message redacted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid key sk-test-an' } }), { status: 401 })));
    const result = await chat(anthropic, input, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).not.toContain('sk-test-an');
  });

  it('stops when the caller aborts, keeping the partial text', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(encoder.encode(data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } })));
          init.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
        },
      }));
    }));
    const result = chat(anthropic, input, { signal: controller.signal, onDelta: () => controller.abort() });
    expect(await result).toMatchObject({ ok: false, stopped: true, text: 'Partial' });
  });

  it('refuses an openai-compatible endpoint that is not https or loopback without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await chat({ ...compatible, baseUrl: 'http://llm.example/v1/chat/completions' }, input, {});
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
