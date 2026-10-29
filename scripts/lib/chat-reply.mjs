// One Agent chat reply as the chat route runs it (decisions #230, #323, #326, #328): choose the mode, build the
// prompt and history, run the model (tool loop or a single streamed reply) and shape the assistant message to save.
// The route keeps HTTP, storage and SSE; this module makes no file writes.
import { runTool, toolDefinitions } from '../../shared/course-tools.ts';
import { toDisplayDocument } from '../../shared/course-data.ts';
import { buildChatContext, chatSystemPrompt } from './chat-context.mjs';
import { runChatWithTools } from './chat-tool-loop.mjs';
import { buildCourseIndex } from './chat-tools-prompt.mjs';
import { chat } from './llm-providers.mjs';

export const HISTORY_BUDGET = 60000;
export const REASONING_LIMIT = 30000;
const TOOL_PROVIDERS = ['deepseek', 'openai-compatible', 'anthropic'];
// Providers whose tool-mode replies store reasoning for replay in later turns.
const REASONING_PROVIDERS = ['deepseek', 'openai-compatible'];

/** Tool mode for DeepSeek, OpenAI-compatible and Anthropic; Codex keeps context mode (decision #251). */
export function chatMode(provider) { return TOOL_PROVIDERS.includes(provider) ? 'tools' : 'context'; }

/**
 * The newest turns that fit the history budget, oldest first. With `reasoning`, stored reasoning is kept on the turns
 * and counted against the budget, because it is sent to the provider.
 */
export function replyHistory(messages, { reasoning }) {
  const history = [];
  let budget = HISTORY_BUDGET;
  for (const message of [...messages].reverse()) {
    if (!message.content) continue;
    const replayed = reasoning && message.role === 'assistant' && message.reasoning ? message.reasoning : '';
    budget -= message.content.length + replayed.length;
    if (budget < 0 && history.length) break;
    history.unshift(replayed ? { role: message.role, content: message.content, reasoning: replayed } : { role: message.role, content: message.content });
  }
  return history;
}

function contextSystem({ documents, courses, scope, today, language }) {
  return `${chatSystemPrompt(language)}\n\n# 课程数据\n\n${buildChatContext(documents, { today, courseIds: scope, courses })}`;
}

/**
 * Run one reply for a chat whose stored messages already end with the new user message.
 * @param {{ config: import('./llm-config.mjs').AnalysisConfig, messages: import('./chat-store.mjs').ChatMessage[],
 *   documents: import('../../shared/course-data.ts').CourseDocument[], courses: { id: string, code?: string, name?: string }[],
 *   scope: string[], today: string, language: 'zh'|'en', planning: import('../../shared/planning-snapshot.ts').SentPlanning | null }} input
 * @param {{ signal?: AbortSignal, onDelta?: (text: string) => void, onStep?: (event: object) => void, cwd?: string }} options
 * @returns {Promise<{ ok: boolean, stopped?: true, error?: string, usage: object|null, model: string|null,
 *   message: import('./chat-store.mjs').ChatMessage | null }>} message is null when there is nothing to save
 */
export async function runChatReply({ config, messages, documents, courses, scope, today, language, planning }, { signal, onDelta, onStep, cwd } = {}) {
  const contextReply = async fallback => {
    const result = await chat(config, { system: contextSystem({ documents, courses, scope, today, language }), messages: replyHistory(messages, { reasoning: false }) }, { signal, onDelta, cwd });
    return finish(result, { mode: 'context', ...(fallback ? { fallback: true } : {}) });
  };
  if (chatMode(config.provider) === 'context') return contextReply(false);

  const display = documents.map(toDisplayDocument);
  const context = { documents: display, courses, scope, today, planning };
  const system = `${chatSystemPrompt(language, 'tools')}\n\n${buildCourseIndex({ documents: display, courses, scope, today, planning })}`;
  const replays = REASONING_PROVIDERS.includes(config.provider);
  const result = await runChatWithTools(config, {
    system, history: replyHistory(messages, { reasoning: replays }), tools: toolDefinitions(),
    runTool: (name, args) => { const { ok, text } = runTool(name, args, context); return { ok, text }; },
  }, { signal, onDelta, onStep });
  // An OpenAI-compatible endpoint that rejected tools on the first request answers once in context mode instead.
  if (result.toolsRejected) return contextReply(true);
  const reasoning = replays && result.reasoning && result.reasoning.length <= REASONING_LIMIT ? result.reasoning : '';
  return finish(result, { mode: 'tools', ...(result.steps.length ? { steps: result.steps } : {}), ...(reasoning ? { reasoning } : {}) });
}

/** Partial text, steps and status are kept when a reply stops or fails, as before tools existed. */
function finish(result, extra) {
  const status = result.stopped ? 'stopped' : result.ok ? undefined : 'error';
  const keep = result.ok || result.text || extra.steps?.length;
  const message = keep ? { role: 'assistant', content: result.text, at: new Date().toISOString(), usage: result.usage, model: result.model, ...(status ? { status } : {}), ...extra } : null;
  return { ok: result.ok, ...(result.stopped ? { stopped: true } : {}), ...(result.error ? { error: result.error } : {}), usage: result.usage, model: result.model, message };
}
