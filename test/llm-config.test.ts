import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlmConfigValidationError, configProblem, publicLlmConfig, readLlmConfig, resolveAnalysisConfig, resolveFromStored, saveLlmConfig,
} from '../scripts/lib/llm-config.mjs';
import { analyse, anthropicSchema, buildAnthropicRequest, testConnection } from '../scripts/lib/llm-providers.mjs';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'llm-config-')); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

async function fieldErrors(input: unknown): Promise<Record<string, string>> {
  try { await saveLlmConfig(dir, input); } catch (error) {
    if (error instanceof LlmConfigValidationError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected a validation error');
}

describe('saveLlmConfig validation', () => {
  it('rejects an unknown provider', async () => {
    expect(await fieldErrors({ provider: 'gemini' })).toHaveProperty('provider');
  });

  it('requires an https or loopback base URL and a model for openai-compatible', async () => {
    expect(await fieldErrors({ provider: 'openai-compatible', model: 'm' })).toHaveProperty('baseUrl');
    expect(await fieldErrors({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://example.com/v1/chat/completions' })).toHaveProperty('baseUrl');
    expect(await fieldErrors({ provider: 'openai-compatible', model: 'm', baseUrl: 'not a url' })).toHaveProperty('baseUrl');
    expect(await fieldErrors({ provider: 'openai-compatible', baseUrl: 'https://example.com/v1/chat/completions' })).toHaveProperty('model');
    await expect(saveLlmConfig(dir, { provider: 'openai-compatible', model: 'm', baseUrl: 'http://127.0.0.1:8080/v1/chat/completions' })).resolves.toBeTruthy();
    await expect(saveLlmConfig(dir, { provider: 'openai-compatible', model: 'm', baseUrl: 'http://localhost:11434/v1/chat/completions' })).resolves.toBeTruthy();
  });

  it('limits model and key length and rejects whitespace in the model', async () => {
    expect(await fieldErrors({ provider: 'deepseek', model: 'a'.repeat(201) })).toHaveProperty('model');
    expect(await fieldErrors({ provider: 'deepseek', model: 'deepseek flash' })).toHaveProperty('model');
    expect(await fieldErrors({ provider: 'deepseek', apiKey: 'k'.repeat(501) })).toHaveProperty('apiKey');
  });

  it('rejects unknown fields', async () => {
    expect(await fieldErrors({ provider: 'deepseek', extra: 1 })).toBeTruthy();
  });
});

describe('saveLlmConfig storage', () => {
  it('writes the file with mode 0600', async () => {
    await saveLlmConfig(dir, { provider: 'anthropic', apiKey: 'sk-test-123' });
    const info = await stat(join(dir, '.local', 'config', 'llm.json'));
    expect(info.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, '.local', 'config', 'llm.json'), 'utf8'))).toMatchObject({ provider: 'anthropic', apiKey: 'sk-test-123' });
  });

  it('keeps the stored key when the key is omitted or empty, and removes it with clearKey', async () => {
    await saveLlmConfig(dir, { provider: 'deepseek', apiKey: 'sk-test-123' });
    await saveLlmConfig(dir, { provider: 'deepseek', model: 'deepseek-pro' });
    expect(await readLlmConfig(dir)).toMatchObject({ model: 'deepseek-pro', apiKey: 'sk-test-123' });
    await saveLlmConfig(dir, { provider: 'deepseek', apiKey: '' });
    expect((await readLlmConfig(dir))?.apiKey).toBe('sk-test-123');
    await saveLlmConfig(dir, { provider: 'deepseek', clearKey: true });
    expect((await readLlmConfig(dir))?.apiKey).toBeUndefined();
  });

  it('does not carry a stored key over to a different provider or endpoint', async () => {
    await saveLlmConfig(dir, { provider: 'deepseek', apiKey: 'sk-test-123' });
    await saveLlmConfig(dir, { provider: 'anthropic' });
    expect((await readLlmConfig(dir))?.apiKey).toBeUndefined();
    await saveLlmConfig(dir, { provider: 'openai-compatible', model: 'm', baseUrl: 'https://a.example/v1/chat/completions', apiKey: 'sk-test-456' });
    await saveLlmConfig(dir, { provider: 'openai-compatible', model: 'm', baseUrl: 'https://b.example/v1/chat/completions' });
    expect((await readLlmConfig(dir))?.apiKey).toBeUndefined();
  });

  it('returns null when nothing is saved', async () => {
    expect(await readLlmConfig(dir)).toBeNull();
  });
});

describe('publicLlmConfig', () => {
  it('never contains the key', async () => {
    const stored = await saveLlmConfig(dir, { provider: 'anthropic', apiKey: 'sk-test-123' });
    const view = publicLlmConfig(stored, { ANTHROPIC_API_KEY: 'sk-test-env' });
    expect(JSON.stringify(view)).not.toContain('sk-test');
    expect(view).toMatchObject({ provider: 'anthropic', hasKey: true, keySource: 'settings', source: 'settings' });
  });

  it('reports environment and missing keys', () => {
    expect(publicLlmConfig(null, { DEEPSEEK_API_KEY: 'sk-test-env' })).toMatchObject({ provider: 'deepseek', hasKey: true, keySource: 'env', source: 'default' });
    expect(publicLlmConfig(null, {})).toMatchObject({ hasKey: false, keySource: 'none', keyRequired: true });
    expect(publicLlmConfig(null, { COURSE_ANALYSIS_PROVIDER: 'codex' })).toMatchObject({ provider: 'codex', source: 'env', keyRequired: false });
  });
});

describe('resolveAnalysisConfig precedence', () => {
  it('uses defaults per provider', () => {
    expect(resolveFromStored(null, {})).toEqual({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, apiKey: null });
    expect(resolveFromStored({ provider: 'anthropic', updatedAt: '' }, {}).model).toBe('claude-sonnet-5-5');
    expect(resolveFromStored({ provider: 'codex', updatedAt: '' }, {}).model).toBe('gpt-6-luna');
  });

  it('prefers environment variables over defaults', () => {
    const env = { COURSE_ANALYSIS_PROVIDER: 'openai-compatible', COURSE_ANALYSIS_URL: 'https://x.example/v1/chat/completions', COURSE_ANALYSIS_MODEL: 'm-env', COURSE_ANALYSIS_API_KEY: 'sk-test-env' };
    expect(resolveFromStored(null, env)).toEqual({ provider: 'openai-compatible', model: 'm-env', baseUrl: 'https://x.example/v1/chat/completions', apiKey: 'sk-test-env' });
    expect(resolveFromStored(null, { DEEPSEEK_API_KEY: 'sk-test-ds' }).apiKey).toBe('sk-test-ds');
    expect(resolveFromStored(null, { COURSE_ANALYSIS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-an' })).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test-an' });
  });

  it('prefers saved settings over environment variables', async () => {
    await saveLlmConfig(dir, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-test-saved' });
    const env = { COURSE_ANALYSIS_PROVIDER: 'deepseek', COURSE_ANALYSIS_MODEL: 'deepseek-pro', COURSE_ANALYSIS_API_KEY: 'sk-test-env', ANTHROPIC_API_KEY: 'sk-test-an' };
    expect(await resolveAnalysisConfig(dir, env)).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: null, apiKey: 'sk-test-saved' });
  });

  it('ignores generic environment model and key meant for another provider', async () => {
    await saveLlmConfig(dir, { provider: 'anthropic' });
    const env = { COURSE_ANALYSIS_PROVIDER: 'deepseek', COURSE_ANALYSIS_MODEL: 'deepseek-pro', COURSE_ANALYSIS_API_KEY: 'sk-test-env' };
    expect(await resolveAnalysisConfig(dir, env)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, apiKey: null });
    expect((await resolveAnalysisConfig(dir, { ...env, ANTHROPIC_API_KEY: 'sk-test-an' })).apiKey).toBe('sk-test-an');
  });

  it('refuses an unrecognised environment provider and ignores the generic variables', async () => {
    const env = { COURSE_ANALYSIS_PROVIDER: 'openai_compatible', COURSE_ANALYSIS_URL: 'https://x.example/v1/chat/completions', COURSE_ANALYSIS_API_KEY: 'sk-test-env', DEEPSEEK_API_KEY: 'sk-test-ds' };
    const config = resolveFromStored(null, env);
    expect(config.apiKey).toBeNull();
    expect(configProblem(config)).toBe('ANALYSIS_PROVIDER_INVALID');
    expect(publicLlmConfig(null, env)).toMatchObject({ providerInvalid: true, hasKey: false });
    expect(await testConnection(config)).toMatchObject({ ok: false });
    // Saved settings choose the provider explicitly, so the bad variable no longer blocks.
    await saveLlmConfig(dir, { provider: 'anthropic', apiKey: 'sk-test-saved' });
    expect(configProblem(await resolveAnalysisConfig(dir, env))).toBeNull();
  });

  it('sends the generic key to an openai-compatible endpoint only on the same origin as COURSE_ANALYSIS_URL', async () => {
    const env = { COURSE_ANALYSIS_PROVIDER: 'openai-compatible', COURSE_ANALYSIS_URL: 'https://a.example/v1/chat/completions', COURSE_ANALYSIS_MODEL: 'm', COURSE_ANALYSIS_API_KEY: 'sk-test-env' };
    await saveLlmConfig(dir, { provider: 'openai-compatible', model: 'm', baseUrl: 'https://b.example/v1/chat/completions' });
    expect((await resolveAnalysisConfig(dir, env)).apiKey).toBeNull();
    await saveLlmConfig(dir, { provider: 'openai-compatible', model: 'm', baseUrl: 'https://a.example/other/chat/completions' });
    expect((await resolveAnalysisConfig(dir, env)).apiKey).toBe('sk-test-env');
  });

  it('never uses a key for codex', () => {
    expect(resolveFromStored(null, { COURSE_ANALYSIS_PROVIDER: 'codex', COURSE_ANALYSIS_API_KEY: 'sk-test-env' }).apiKey).toBeNull();
  });
});

describe('buildAnthropicRequest', () => {
  const schema = { type: 'object', properties: { n: { type: 'number', minimum: 0, maximum: 5 } }, required: ['n'] };
  it('sends the key only in x-api-key and requests schema-constrained streaming output', () => {
    const request = buildAnthropicRequest({ model: 'claude-sonnet-5-5', apiKey: 'sk-test-123', prompt: 'hello', schema });
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'sk-test-123', 'anthropic-version': '2023-06-01' });
    const body = JSON.parse(request.body);
    expect(JSON.stringify(body)).not.toContain('sk-test-123');
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.tool_choice).toBeUndefined();
  });

  it('strips numeric constraints and closes every object schema', () => {
    expect(anthropicSchema(schema)).toEqual({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false });
  });

  it('builds a small non-streaming request without a schema for the connection test', () => {
    const body = JSON.parse(buildAnthropicRequest({ model: 'claude-sonnet-5-5', apiKey: 'sk-test-123', prompt: 'Reply with OK', maxTokens: 256 }).body);
    expect(body).toMatchObject({ max_tokens: 256, stream: false });
    expect(body.output_config).toBeUndefined();
  });
});

describe('adapters with a mocked fetch', () => {
  const options = { schema: { type: 'object' }, schemaPath: '', cwd: '', registerStop: () => () => {} };
  function sse(events: object[]) {
    const text = events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(new Blob([text]).stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('keeps the DeepSeek request shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 3, output_tokens: 2 } })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyse({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, apiKey: 'sk-test-123' }, 'p', options);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/responses');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-123' });
    expect(JSON.parse(init.body as string)).toEqual({ model: 'deepseek-flash', input: 'p', text: { format: { type: 'json_schema', name: 'course_analysis', schema: { type: 'object' } } } });
    expect(result).toMatchObject({ exitCode: 0, lastMessage: '{}', usage: { input: 3, output: 2 } });
  });

  const claude = { provider: 'anthropic' as const, model: 'claude-sonnet-5-5', baseUrl: null, apiKey: 'sk-test-123' };
  it('fails an Anthropic stream that reports an error event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])));
    const result = await analyse(claude, 'p', options);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Overloaded');
  });

  it('fails an Anthropic stream that ends without a stop reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{}' } }])));
    expect((await analyse(claude, 'p', options)).exitCode).toBe(1);
  });

  it('succeeds on a complete Anthropic stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 4, output_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{}' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }, { type: 'message_stop' }])));
    expect(await analyse(claude, 'p', options)).toMatchObject({ exitCode: 0, lastMessage: '{}', usage: { input: 9, cached: 4, output: 7 } });
  });
});
