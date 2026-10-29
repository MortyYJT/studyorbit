import { describe, expect, it } from 'vitest';
import { appendToolRound, buildToolRequest, toolConversation, toolStepParser } from '../scripts/lib/llm-providers.mjs';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';

// Wire adapters for tool calling (decision #325). Pure: no network. Synthetic data only.
const deepseek: AnalysisConfig = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, apiKey: 'sk-test-ds' };
const compatible: AnalysisConfig = { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'https://llm.example/v1/chat/completions', apiKey: 'sk-test-oc' };
const anthropic: AnalysisConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, apiKey: 'sk-test-an' };
const tools = [{ name: 'list_courses', description: 'List courses', parameters: { type: 'object' as const, properties: {} } },
  { name: 'calculate_grades', description: 'Grades', parameters: { type: 'object' as const, properties: { courseId: { type: 'string' } }, required: ['courseId'] } }];

function parse(provider: string, events: unknown[]) {
  const deltas: string[] = [];
  const parser = toolStepParser(provider, 'sk-test', (text: string) => deltas.push(text));
  for (const event of events) parser.event(event);
  return { ...parser.result(), deltas };
}

describe('buildToolRequest', () => {
  it('sends DeepSeek Responses function tools with tool choice', () => {
    const conversation = toolConversation('deepseek', [{ role: 'user', content: 'Hi' }]);
    const request = buildToolRequest(deepseek, { system: 'SYS', conversation, tools, choice: 'auto' });
    expect(request.url).toBe('https://api.deepseek.com/responses');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ model: 'deepseek-flash', instructions: 'SYS', stream: true, tool_choice: 'auto', input: [{ role: 'user', content: 'Hi' }] });
    expect(body.tools[1]).toEqual({ type: 'function', name: 'calculate_grades', description: 'Grades', parameters: tools[1]!.parameters });
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(JSON.parse(buildToolRequest(deepseek, { system: 'SYS', conversation, tools, choice: 'none' }).body).tool_choice).toBe('none');
    expect(request.body).not.toContain('sk-test-ds');
  });

  it('sends chat-completions tools with a system message', () => {
    const conversation = toolConversation('openai-compatible', [{ role: 'user', content: 'Hi' }]);
    const body = JSON.parse(buildToolRequest(compatible, { system: 'SYS', conversation, tools, choice: 'none' }).body);
    expect(body).toMatchObject({ model: 'synthetic-model', stream: true, stream_options: { include_usage: true }, tool_choice: 'none' });
    expect(body.messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Hi' }]);
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'list_courses', description: 'List courses', parameters: tools[0]!.parameters } });
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(JSON.stringify(body.tools)).not.toContain('strict');
  });

  it('sends Messages tools with the cached system block and auto or none choice', () => {
    const conversation = toolConversation('anthropic', [{ role: 'user', content: 'Hi' }]);
    const request = buildToolRequest(anthropic, { system: 'SYS', conversation, tools, choice: 'auto' });
    expect(request.headers['x-api-key']).toBe('sk-test-an');
    const body = JSON.parse(request.body);
    expect(body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[1]).toEqual({ name: 'calculate_grades', description: 'Grades', input_schema: tools[1]!.parameters });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.thinking).toBeUndefined();
    expect(JSON.parse(buildToolRequest(anthropic, { system: 'SYS', conversation, tools, choice: 'none' }).body).tool_choice).toEqual({ type: 'none' });
  });
});

describe('toolConversation (earlier turns)', () => {
  it('replays DeepSeek reasoning as a reasoning item before the assistant message', () => {
    const input = toolConversation('deepseek', [
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1', reasoning: 'thought 1' }, { role: 'user', content: 'Q2' },
    ]);
    expect(input).toEqual([
      { role: 'user', content: 'Q1' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thought 1' }] },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]);
  });

  it('folds DeepSeek turns up to the last reasoning-less assistant turn into a transcript', () => {
    const input = toolConversation('deepseek', [
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'Q3' }, { role: 'assistant', content: 'A3', reasoning: 'r3' },
      { role: 'user', content: 'Q4' },
    ]) as { role?: string; type?: string; content: unknown }[];
    expect(input.filter(entry => entry.role === 'assistant').map(entry => entry.content)).toEqual(['A3']);
    const first = input[0] as { role: string; content: string };
    expect(first.role).toBe('user');
    expect(first.content).toContain('之前的对话');
    for (const text of ['Q1', 'A1', 'Q2', 'A2']) expect(first.content).toContain(text);
    expect(first.content.endsWith('Q3')).toBe(true);
    expect(input.slice(1)).toEqual([
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'r3' }] }, { role: 'assistant', content: 'A3' }, { role: 'user', content: 'Q4' },
    ]);
  });

  it('sends no reasoning-less assistant message to DeepSeek when the last turn has none', () => {
    const input = toolConversation('deepseek', [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }]);
    expect(input).toHaveLength(1);
    expect((input[0] as { content: string }).content).toMatch(/之前的对话[\s\S]*Q1[\s\S]*A1[\s\S]*Q2$/);
  });

  it('adds reasoning_content for chat completions', () => {
    const history = [{ role: 'user' as const, content: 'Q1' }, { role: 'assistant' as const, content: 'A1', reasoning: 'r1' }, { role: 'user' as const, content: 'Q2' }];
    expect(toolConversation('openai-compatible', history)).toEqual([
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1', reasoning_content: 'r1' }, { role: 'user', content: 'Q2' },
    ]);
  });

  it('folds chat-completions turns up to the last reasoning-less assistant turn, so an old chat can continue on a thinking endpoint', () => {
    const input = toolConversation('openai-compatible', [
      { role: 'user', content: 'Q0' }, { role: 'assistant', content: 'A0 from context mode' },
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1', reasoning: 'r1' },
      { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2 fallback reply' },
      { role: 'user', content: 'Q3' },
    ]) as { role: string; content: string; reasoning_content?: string }[];
    expect(input.filter(entry => entry.role === 'assistant')).toEqual([]);
    expect(input).toHaveLength(1);
    expect(input[0]!.content).toMatch(/之前的对话[\s\S]*Q0[\s\S]*A0 from context mode[\s\S]*A1[\s\S]*A2 fallback reply[\s\S]*Q3$/);
    const kept = toolConversation('openai-compatible', [
      { role: 'user', content: 'Q0' }, { role: 'assistant', content: 'A0' },
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1', reasoning: 'r1' }, { role: 'user', content: 'Q2' },
    ]) as { role: string; content: string; reasoning_content?: string }[];
    expect(kept.slice(1)).toEqual([{ role: 'assistant', content: 'A1', reasoning_content: 'r1' }, { role: 'user', content: 'Q2' }]);
    expect(kept[0]!.content).toMatch(/之前的对话[\s\S]*A0[\s\S]*Q1$/);
  });

  it('sends plain text turns to Anthropic', () => {
    const history = [{ role: 'assistant' as const, content: 'lead' }, { role: 'user' as const, content: 'Q1' }, { role: 'assistant' as const, content: 'A1', reasoning: 'r1' }, { role: 'assistant' as const, content: 'A1b' }, { role: 'user' as const, content: 'Q2' }];
    expect(toolConversation('anthropic', history)).toEqual([
      { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'assistant', content: 'A1b' }, { role: 'user', content: 'Q2' },
    ]);
  });
});

describe('toolStepParser', () => {
  it('reads DeepSeek calls from output_item.done, text and reasoning deltas, and usage', () => {
    const step = parse('deepseek', [
      { type: 'response.reasoning_text.delta', delta: 'Need ' }, { type: 'response.reasoning_text.delta', delta: 'grades.' },
      { type: 'response.output_text.delta', delta: 'Checking.' },
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'calculate_grades', arguments: '' } },
      { type: 'response.function_call_arguments.delta', delta: '{"courseId":' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'calculate_grades', arguments: '{"courseId":"syn-1"}' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'list_courses', arguments: '' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30, output_tokens: 8 } } },
    ]);
    expect(step.error).toBeNull();
    expect(step.text).toBe('Checking.');
    expect(step.deltas).toEqual(['Checking.']);
    expect(step.reasoning).toBe('Need grades.');
    expect(step.calls).toEqual([{ id: 'c1', name: 'calculate_grades', args: '{"courseId":"syn-1"}' }, { id: 'c2', name: 'list_courses', args: '' }]);
    expect(step.usage).toMatchObject({ input: 30, output: 8 });
  });

  it('reports an unfinished DeepSeek stream', () => {
    expect(parse('deepseek', [{ type: 'response.output_text.delta', delta: 'x' }]).error).toMatch(/中断/);
  });

  it('merges chat-completions fragments by index, fills missing IDs and accepts finish_reason stop with calls', () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    const step = parse('openai-compatible', [
      chunk({ reasoning_content: 'think' }),
      chunk({ content: 'Let me check.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'calc', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: 'ulate_grades', arguments: '{"course' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { name: 'list_courses', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'Id":"syn-1"}' } }] }),
      chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } },
    ]);
    expect(step.error).toBeNull();
    expect(step.reasoning).toBe('think');
    expect(step.text).toBe('Let me check.');
    expect(step.calls).toHaveLength(2);
    expect(step.calls[0]).toEqual({ id: 'call_a', name: 'calculate_grades', args: '{"courseId":"syn-1"}' });
    expect(step.calls[1]).toMatchObject({ name: 'list_courses', args: '' });
    expect(step.calls[1]!.id).toMatch(/\S/);
    expect(step.usage).toMatchObject({ input: 40, output: 9 });
  });

  it('treats a chat-completions length cut as an error even with calls', () => {
    const step = parse('openai-compatible', [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'list_courses', arguments: '{' } }] }, finish_reason: 'length' }] }]);
    expect(step.error).toMatch(/长度/);
  });

  it('reads Anthropic tool_use blocks with input_json_delta, empty input, and keeps thinking blocks', () => {
    const step = parse('anthropic', [
      { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking up.' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'calculate_grades', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"courseId"' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ': "syn-1"}' } },
      { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu2', name: 'list_courses', input: {} } },
      { type: 'content_block_stop', index: 3 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ]);
    expect(step.error).toBeNull();
    expect(step.text).toBe('Looking up.');
    expect(step.calls).toEqual([{ id: 'tu1', name: 'calculate_grades', args: '{"courseId": "syn-1"}' }, { id: 'tu2', name: 'list_courses', args: '{}' }]);
    expect(step.usage).toMatchObject({ input: 60, cached: 10, output: 20 });
    expect(step.reasoning).toBe('');
  });
});

describe('appendToolRound', () => {
  it('puts each DeepSeek function_call_output directly after its own function_call', () => {
    const step = parse('deepseek', [
      { type: 'response.reasoning_text.delta', delta: 'r' }, { type: 'response.output_text.delta', delta: 'Sure.' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'list_courses', arguments: '' } },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c2', name: 'calculate_grades', arguments: '{"courseId":"syn-1"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const next = appendToolRound('deepseek', [{ role: 'user', content: 'Q' }], step, [{ text: 'R1', ok: true }, { text: 'R2', ok: false }]);
    expect(next).toEqual([
      { role: 'user', content: 'Q' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'r' }] },
      { role: 'assistant', content: 'Sure.' },
      { type: 'function_call', call_id: 'c1', name: 'list_courses', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'R1' },
      { type: 'function_call', call_id: 'c2', name: 'calculate_grades', arguments: '{"courseId":"syn-1"}' },
      { type: 'function_call_output', call_id: 'c2', output: 'R2' },
    ]);
  });

  it('appends the chat-completions assistant message with tool_calls, then one tool message per call', () => {
    const step = { text: '', reasoning: 'r', calls: [{ id: 'a', name: 'list_courses', args: '' }, { id: 'b', name: 'calculate_grades', args: '{"courseId":"syn-1"}' }], usage: null, error: null };
    expect(appendToolRound('openai-compatible', [], step, [{ text: 'R1', ok: true }, { text: 'R2', ok: true }])).toEqual([
      { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'list_courses', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'calculate_grades', arguments: '{"courseId":"syn-1"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'R1' },
      { role: 'tool', tool_call_id: 'b', content: 'R2' },
    ]);
  });

  it('appends the Anthropic assistant blocks as received, then a user message of only tool_result blocks', () => {
    const step = parse('anthropic', [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'calculate_grades', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"courseId":"syn-1"}' } },
      { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu2', name: 'final_needed', input: {} } },
      { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"courseId": ' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    const next = appendToolRound('anthropic', [{ role: 'user', content: 'Q' }], step, [{ text: 'R1', ok: true }, { text: 'E2', ok: false }]);
    expect(next).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'tool_use', id: 'tu1', name: 'calculate_grades', input: { courseId: 'syn-1' } },
        { type: 'tool_use', id: 'tu2', name: 'final_needed', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'R1' },
        { type: 'tool_result', tool_use_id: 'tu2', content: 'E2', is_error: true },
      ] },
    ]);
  });
});
