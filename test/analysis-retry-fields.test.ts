import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyse, isTemporaryFailure, parseRetryAfter } from '../scripts/lib/llm-providers.mjs';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';

// Course analysis results expose `httpStatus` and `retryAfterMs` so the model limiter can retry HTTP 429, HTTP 5xx and
// connection errors before a response (design §9). Fetch is mocked; no real model is called.
afterEach(() => { vi.unstubAllGlobals(); });

const configs: AnalysisConfig[] = [
  { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: null, apiKey: 'sk-synthetic' },
  { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'https://llm.example.org/v1/chat/completions', apiKey: 'sk-synthetic' },
  { provider: 'anthropic', model: 'claude-synthetic', baseUrl: null, apiKey: 'sk-synthetic' },
];
const options = { schema: { type: 'object' }, schemaPath: '/nonexistent/schema.json', cwd: '/nonexistent', registerStop: () => () => {} };

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and ignores anything else', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Fri, 30 Oct 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Thu, 29 Oct 2026 23:00:00 GMT', now)).toBe(0);
    for (const value of [null, '', '-1', '1.5', 'soon']) expect(parseRetryAfter(value, now)).toBeNull();
  });
});

describe('analyse result retry fields', () => {
  it.each(configs)('$provider: HTTP 429 carries httpStatus and Retry-After in ms and is temporary', async config => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '3' } })));
    const result = await analyse(config, 'prompt', options);
    expect(result).toMatchObject({ exitCode: 1, httpStatus: 429, retryAfterMs: 3000 });
    expect(isTemporaryFailure(result)).toBe(true);
  });

  it.each(configs)('$provider: HTTP 503 is temporary, HTTP 401 is not', async config => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const unavailable = await analyse(config, 'prompt', options);
    expect(unavailable).toMatchObject({ exitCode: 1, httpStatus: 503, retryAfterMs: null });
    expect(isTemporaryFailure(unavailable)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const denied = await analyse(config, 'prompt', options);
    expect(denied).toMatchObject({ exitCode: 1, httpStatus: 401 });
    expect(isTemporaryFailure(denied)).toBe(false);
  });

  it.each(configs)('$provider: a connection error before a response is retryable, an abort is not', async config => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const failed = await analyse(config, 'prompt', options);
    expect(failed).toMatchObject({ exitCode: 1, retryable: true });
    expect(isTemporaryFailure(failed)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    const aborted = await analyse(config, 'prompt', options);
    expect(aborted).toMatchObject({ exitCode: 1, error: '模型请求已中止或超时。' });
    expect(isTemporaryFailure(aborted)).toBe(false);
  });

  it('keeps successful results unchanged apart from httpStatus 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"status":"failed"}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200 })));
    const result = await analyse(configs[1]!, 'prompt', options);
    expect(result).toEqual({ exitCode: 0, lastMessage: '{"status":"failed"}', usage: { input: 10, cached: null, output: 2, reasoning: null }, threadId: null, httpStatus: 200 });
    expect(isTemporaryFailure(result)).toBe(false);
  });

  it('does not treat an incomplete DeepSeek result as temporary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'incomplete', output: [] }), { status: 200 })));
    const result = await analyse(configs[0]!, 'prompt', options);
    expect(result).toMatchObject({ exitCode: 1, httpStatus: 200 });
    expect(isTemporaryFailure(result)).toBe(false);
  });
});
