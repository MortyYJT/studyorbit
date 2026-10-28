// Course-analysis model adapters behind one entry point, `analyse(config, prompt, options)`.
// Every adapter returns { exitCode, lastMessage, usage, threadId?, error? }, stops after 15 minutes and can be
// cancelled through `registerStop`. Keys are sent only in the provider's auth header and never logged or echoed.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAllowedEndpoint } from './llm-config.mjs';

const ANALYSIS_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 30 * 1000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MAX_TOKENS = 64000;

/** Normalise provider usage objects into { input, cached, output, reasoning }; input includes cached tokens. */
export const counts = usage => {
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return null;
  const cached = usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens;
  return { input, cached: Number.isSafeInteger(cached) ? cached : null, output, reasoning: Number.isSafeInteger(reasoning) ? reasoning : null };
};

/** Anthropic usage reports cache reads/writes separately from input_tokens; fold them in so input means total input. */
export function anthropicUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
  const read = Number.isSafeInteger(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0;
  const written = Number.isSafeInteger(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0;
  return counts({ input_tokens: usage.input_tokens + read + written, output_tokens: usage.output_tokens, cached_input_tokens: read });
}

// Keywords the Anthropic structured-output schema does not accept; local zod validation still enforces them.
const UNSUPPORTED_SCHEMA_KEYS = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties']);

/** Convert a JSON Schema into the subset Anthropic structured outputs accept (closed objects, no numeric/string limits). */
export function anthropicSchema(schema) {
  if (Array.isArray(schema)) return schema.map(anthropicSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'minItems' && value > 1) continue;
    out[key] = key === 'properties' ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, anthropicSchema(entry)])) : anthropicSchema(value);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

/**
 * Build a Messages API request. With a schema it streams and constrains the reply via output_config.format
 * (forced tool_choice is rejected by current models such as claude-sonnet-5-5). Pure: no network.
 */
export function buildAnthropicRequest({ model, apiKey, prompt, schema, maxTokens }) {
  const body = { model, max_tokens: maxTokens ?? ANTHROPIC_MAX_TOKENS, stream: Boolean(schema), messages: [{ role: 'user', content: prompt }] };
  if (schema) body.output_config = { format: { type: 'json_schema', schema: anthropicSchema(schema) } };
  return { url: ANTHROPIC_URL, headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) };
}

function redact(text, key) {
  const value = String(text ?? '').slice(0, 300);
  return key ? value.split(key).join('[key]') : value;
}

async function providerError(response, key) {
  try {
    const data = await response.json();
    const message = data?.error?.message ?? (typeof data?.error === 'string' ? data.error : '') ?? '';
    return message ? `：${redact(message, key)}` : '';
  } catch { return ''; }
}

/** Read Anthropic server-sent events and hand each parsed `data:` payload to `onEvent`. */
async function readEvents(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let event; try { event = JSON.parse(data); } catch { return; }
    onEvent(event);
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) { flush(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
  }
  if (buffer.trim()) flush(buffer);
}

function withTimeout(registerStop, ms) {
  const controller = new AbortController();
  const untrack = registerStop(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => { clearTimeout(timer); untrack(); } };
}

// DeepSeek Responses API: native schema output and local semantic validation.
async function runDeepSeek(config, prompt, schema, registerStop) {
  const { signal, done } = withTimeout(registerStop, ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, input: prompt, text: { format: { type: 'json_schema', name: 'course_analysis', schema } } }),
    });
    if (!response.ok) return { exitCode: 1, lastMessage: '', usage: null, error: `DeepSeek 接口返回 HTTP ${response.status}。` };
    const data = await response.json();
    const lastMessage = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('');
    if (data.status !== 'completed') return { exitCode: 1, lastMessage, usage: counts(data.usage), error: `DeepSeek 结果未完成：${data.status || '未知'}。` };
    return { exitCode: 0, lastMessage, usage: counts(data.usage), threadId: null };
  } catch (error) {
    return { exitCode: 1, lastMessage: '', usage: null, error: error.name === 'AbortError' ? '模型请求已中止或超时。' : 'DeepSeek 接口连接失败。' };
  } finally { done(); }
}

// OpenAI-compatible chat-completions endpoint (full URL), JSON mode plus local validation.
async function runCompatible(config, prompt, registerStop) {
  if (!isAllowedEndpoint(config.baseUrl)) return { exitCode: 1, lastMessage: '', usage: null, error: '模型接口必须使用 HTTPS 或本机地址。' };
  const { signal, done } = withTimeout(registerStop, ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(config.baseUrl, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    });
    if (!response.ok) return { exitCode: 1, lastMessage: '', usage: null, error: `模型接口返回 HTTP ${response.status}。` };
    const data = await response.json();
    return { exitCode: 0, lastMessage: data.choices?.[0]?.message?.content ?? '', usage: counts(data.usage), threadId: null };
  } catch (error) {
    return { exitCode: 1, lastMessage: '', usage: null, error: error.name === 'AbortError' ? '模型请求已中止或超时。' : '模型接口连接失败。' };
  } finally { done(); }
}

// Anthropic Messages API, streamed, with the reply constrained to the course schema.
async function runAnthropic(config, prompt, schema, registerStop) {
  const request = buildAnthropicRequest({ model: config.model, apiKey: config.apiKey, prompt, schema });
  const { signal, done } = withTimeout(registerStop, ANALYSIS_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, { method: 'POST', signal, headers: request.headers, body: request.body });
    if (!response.ok || !response.body) return { exitCode: 1, lastMessage: '', usage: null, error: `Anthropic 接口返回 HTTP ${response.status}${await providerError(response, config.apiKey)}。` };
    let text = '', usage = null, stopReason = null, streamError = null;
    await readEvents(response.body, event => {
      if (event.type === 'message_start') usage = { ...event.message?.usage };
      else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text ?? '';
      else if (event.type === 'message_delta') { stopReason = event.delta?.stop_reason ?? stopReason; usage = { ...usage, ...event.usage }; }
      else if (event.type === 'error') streamError = event.error?.message ?? event.error?.type ?? 'unknown';
    });
    const normalised = anthropicUsage(usage);
    if (streamError) return { exitCode: 1, lastMessage: text, usage: normalised, error: `Anthropic 接口出错：${redact(streamError, config.apiKey)}。` };
    if (stopReason !== 'end_turn') return { exitCode: 1, lastMessage: text, usage: normalised, error: stopReason === 'refusal' ? 'Claude 拒绝了这次请求。' : stopReason === 'max_tokens' ? 'Claude 输出超出长度上限。' : `Claude 结果未完成：${stopReason || '未知'}。` };
    return { exitCode: 0, lastMessage: text, usage: normalised, threadId: null };
  } catch (error) {
    return { exitCode: 1, lastMessage: '', usage: null, error: error.name === 'AbortError' ? '模型请求已中止或超时。' : 'Anthropic 接口连接失败。' };
  } finally { done(); }
}

// Codex CLI in a read-only sandbox; no API key is involved.
function runCodex(config, prompt, schemaPath, cwd, registerStop, onPhase) {
  return new Promise(resolveRun => {
    let threadId = null, usage = null, lastMessage = '', completed = false, code = null;
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-m', config.model, '-c', 'agents.enabled=false', '--output-schema', schemaPath, '-'];
    const proc = spawn('codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let hardStop;
    const signal = name => { try { if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' }); } else if (proc.pid) process.kill(-proc.pid, name); } catch { /* Process already exited. */ } };
    const stop = () => { signal('SIGTERM'); if (!hardStop) hardStop = setTimeout(() => signal('SIGKILL'), 5000); };
    const untrack = registerStop(stop);
    const timer = setTimeout(stop, ANALYSIS_TIMEOUT_MS);
    const done = exitCode => { if (completed) return; completed = true; clearTimeout(timer); untrack(); resolveRun({ threadId, usage, lastMessage, exitCode }); };
    proc.on('error', () => done(null));
    proc.stderr.resume();
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') { threadId = event.thread_id; onPhase?.('reading'); }
      if (event.type === 'turn.completed') usage = counts(event.usage);
      if (event.type === 'turn.failed' || event.type === 'error') code = 1;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') lastMessage = event.item.text;
    });
    proc.on('close', exitCode => done(code ?? exitCode));
  });
}

/**
 * Run one course analysis with the resolved provider config.
 * @param {{provider: string, model: string|null, baseUrl: string|null, apiKey: string|null}} config
 * @param {string} prompt
 * @param {{schema: object, schemaPath: string, cwd: string, registerStop: (stop: () => void) => () => void, onPhase?: (phase: string) => void}} options
 */
export function analyse(config, prompt, { schema, schemaPath, cwd, registerStop, onPhase }) {
  switch (config.provider) {
    case 'deepseek': return runDeepSeek(config, prompt, schema, registerStop);
    case 'openai-compatible': return runCompatible(config, prompt, registerStop);
    case 'anthropic': return runAnthropic(config, prompt, schema, registerStop);
    case 'codex': return runCodex(config, prompt, schemaPath, cwd, registerStop, onPhase);
    default: return Promise.resolve({ exitCode: 1, lastMessage: '', usage: null, error: `未知分析提供方：${config.provider}` });
  }
}

/** Send a minimal request (or run `codex --version`) to check the config works. Never returns the key. */
export async function testConnection(config) {
  const started = Date.now();
  const result = (ok, error) => ({ ok, latencyMs: Date.now() - started, model: config.model, ...(error ? { error } : {}) });
  if (config.invalidProvider) return result(false, 'COURSE_ANALYSIS_PROVIDER 不是可识别的提供方，请在设置里选择或修正环境变量。');
  if (config.provider === 'codex') {
    return new Promise(resolveTest => execFile('codex', ['--version'], { timeout: 10000 }, error => resolveTest(result(!error, error ? '无法运行 codex 命令，请确认已安装 Codex CLI。' : undefined))));
  }
  if (!config.apiKey) return result(false, '没有可用的 API 密钥。');
  if (!config.model) return result(false, '没有设置模型。');
  const prompt = 'Reply with OK';
  let request;
  if (config.provider === 'anthropic') request = buildAnthropicRequest({ model: config.model, apiKey: config.apiKey, prompt, maxTokens: 256 });
  else if (config.provider === 'deepseek') request = { url: 'https://api.deepseek.com/responses', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, input: prompt }) };
  else if (config.provider === 'openai-compatible') {
    if (!config.baseUrl || !isAllowedEndpoint(config.baseUrl)) return result(false, '接口地址无效，必须使用 HTTPS 或本机地址。');
    request = { url: config.baseUrl, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }] }) };
  } else return result(false, `未知分析提供方：${config.provider}`);
  const { signal, done } = withTimeout(() => () => {}, TEST_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, { method: 'POST', signal, headers: request.headers, body: request.body });
    if (!response.ok) return result(false, `HTTP ${response.status}${await providerError(response, config.apiKey)}`);
    await response.body?.cancel();
    return result(true);
  } catch (error) {
    return result(false, error.name === 'AbortError' ? '请求超时。' : '无法连接模型接口。');
  } finally { done(); }
}
