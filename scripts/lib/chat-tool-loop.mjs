// Bounded tool loop for Agent chat (decision #324): stream a step, run the requested tools in-process, append the
// round in the provider's wire format (llm-providers.mjs) and repeat until the model answers.
// Limits: 8 model requests and 16 tool calls per reply, 40 000 characters of tool results, 5 minutes in total.
import { isAllowedEndpoint } from './llm-config.mjs';
import { appendToolRound, buildToolRequest, CHAT_TIMEOUT_MS, readServerEvents, responseError, toolConversation, toolStepParser } from './llm-providers.mjs';

export const TOOL_LOOP_LIMITS = Object.freeze({ requests: 8, calls: 16, resultChars: 40000, result: 8000, args: 2000, preview: 200 });
const NO_ANSWER = '模型没有在步数内给出回答。';

const toolError = (code, message) => JSON.stringify({ error: { code, message } });
const BUDGET_TEXT = toolError('TOOL_BUDGET_EXHAUSTED', 'The tool budget for this reply is used up. Answer with what you have and say what could not be looked up.');

/**
 * Whether a failed first request means the endpoint does not support tools: HTTP 400, 404 or 422 whose error text is
 * about tools (tool, tools, tool_choice, function_call, function calling) and does not mention reasoning.
 */
export function rejectsTools(status, body) {
  return [400, 404, 422].includes(status) && /tool|function[ _]call/i.test(body) && !/reasoning/i.test(body);
}

function addUsage(total, usage) {
  if (!usage) return total;
  if (!total) return { ...usage };
  const sum = (a, b) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return { input: total.input + usage.input, cached: sum(total.cached, usage.cached), output: total.output + usage.output, reasoning: sum(total.reasoning, usage.reasoning) };
}

/** Arguments as an object: empty text is {}, anything else must be JSON (validated against the schema by runTool). */
function parseArgs(text) {
  if (!text.trim()) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}

/**
 * Run one tool-mode reply.
 * @param {import('./llm-config.mjs').AnalysisConfig} config deepseek, openai-compatible or anthropic
 * @param {{ system: string, history: { role: 'user'|'assistant', content: string, reasoning?: string }[],
 *   tools: { name: string, description: string, parameters: object }[],
 *   runTool: (name: string, args: unknown) => { ok: boolean, text: string } }} input
 * @param {{ signal?: AbortSignal, onDelta?: (text: string) => void, onStep?: (event: object) => void }} options
 * @returns {Promise<{ ok: boolean, text: string, usage: object|null, model: string|null, steps: object[], reasoning: string,
 *   stopped?: true, error?: string, toolsRejected?: true }>}
 */
export async function runChatWithTools(config, { system, history, tools, runTool }, { signal, onDelta, onStep } = {}) {
  const texts = [], reasoning = [], steps = [];
  let usage = null, calls = 0, resultChars = 0, spent = false;
  const outcome = extra => ({ text: texts.filter(Boolean).join('\n\n'), usage, model: config.model, steps, reasoning: reasoning.filter(Boolean).join('\n\n'), ...extra });
  if (config.provider === 'openai-compatible' && !isAllowedEndpoint(config.baseUrl ?? '')) return outcome({ ok: false, error: '模型接口必须使用 HTTPS 或本机地址。' });
  const combined = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]);
  let conversation = toolConversation(config.provider, history);

  for (let request = 1; request <= TOOL_LOOP_LIMITS.requests; request += 1) {
    if (signal?.aborted) return outcome({ ok: false, stopped: true });
    const choice = request === TOOL_LOOP_LIMITS.requests || spent ? 'none' : 'auto';
    const http = buildToolRequest(config, { system, conversation, tools, choice });
    // Text of each step is joined by a blank line, so the stream gets the same separator before a later step's text.
    let started = false;
    const parser = toolStepParser(config.provider, config.apiKey, delta => {
      if (!started) { started = true; if (texts.some(Boolean)) onDelta?.('\n\n'); }
      onDelta?.(delta);
    });
    let step;
    try {
      const response = await fetch(http.url, { method: 'POST', signal: combined, headers: http.headers, body: http.body });
      if (!response.ok || !response.body) {
        const { body, message } = await responseError(response, config.apiKey);
        const toolsRejected = request === 1 && config.provider === 'openai-compatible' && rejectsTools(response.status, body);
        return outcome({ ok: false, error: `模型接口返回 HTTP ${response.status}${message ? `：${message}` : ''}。`, ...(toolsRejected ? { toolsRejected: true } : {}) });
      }
      await readServerEvents(response.body, event => parser.event(event));
      step = parser.result();
    } catch (error) {
      const partial = parser.result();
      texts.push(partial.text); usage = addUsage(usage, partial.usage);
      if (signal?.aborted) return outcome({ ok: false, stopped: true });
      return outcome({ ok: false, error: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? '模型回复超时。' : '无法连接模型接口。' });
    }
    texts.push(step.text);
    reasoning.push(step.reasoning);
    usage = addUsage(usage, step.usage);
    if (step.error) return outcome({ ok: false, error: step.error });
    if (!step.calls.length) return outcome({ ok: true });
    if (choice === 'none') return outcome({ ok: false, error: NO_ANSWER });

    const results = [];
    for (const call of step.calls) {
      if (calls >= TOOL_LOOP_LIMITS.calls || resultChars >= TOOL_LOOP_LIMITS.resultChars) { spent = true; results.push({ text: BUDGET_TEXT, ok: false }); continue; }
      calls += 1;
      const recorded = steps.length < TOOL_LOOP_LIMITS.calls;
      const index = steps.length;
      const args = call.args.trim() ? call.args : '{}';
      const shownArgs = args.slice(0, TOOL_LOOP_LIMITS.args);
      if (recorded) onStep?.({ index, name: call.name, args: shownArgs, state: 'running' });
      const begun = Date.now();
      const parsed = parseArgs(call.args);
      let result = parsed.ok
        ? runTool(call.name, parsed.value)
        : { ok: false, text: toolError('INVALID_ARGUMENTS', `Arguments are not valid JSON (${parsed.message}). Send one JSON object.`) };
      if (result.text.length > TOOL_LOOP_LIMITS.result) result = { ok: false, text: toolError('RESULT_TOO_LARGE', `The result is larger than ${TOOL_LOOP_LIMITS.result} characters. Ask for less at a time.`) };
      if (resultChars + result.text.length > TOOL_LOOP_LIMITS.resultChars) { spent = true; result = { ok: false, text: BUDGET_TEXT }; }
      resultChars += result.text.length;
      if (calls >= TOOL_LOOP_LIMITS.calls || resultChars >= TOOL_LOOP_LIMITS.resultChars) spent = true;
      results.push(result);
      if (recorded) {
        steps.push({ name: call.name.slice(0, 64), args: shownArgs, ok: result.ok, result: result.text, ms: Date.now() - begun });
        onStep?.({ index, state: 'done', ok: result.ok, preview: result.text.slice(0, TOOL_LOOP_LIMITS.preview) });
      }
    }
    conversation = appendToolRound(config.provider, conversation, step, results);
  }
  return outcome({ ok: false, error: NO_ANSWER });
}
