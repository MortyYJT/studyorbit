import { afterEach, describe, expect, it, vi } from 'vitest';
import { rejectsTools, runChatWithTools, TOOL_LOOP_LIMITS } from '../scripts/lib/chat-tool-loop.mjs';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';

// The bounded tool loop (decision #324) with scripted provider streams; no real model calls. Synthetic data only.
afterEach(() => { vi.unstubAllGlobals(); });

const deepseek: AnalysisConfig = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, apiKey: 'sk-test-ds' };
const compatible: AnalysisConfig = { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'https://llm.example/v1/chat/completions', apiKey: 'sk-test-oc' };
const anthropic: AnalysisConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, apiKey: 'sk-test-an' };
const tools = [{ name: 'list_courses', description: 'List', parameters: { type: 'object' as const, properties: {} } },
  { name: 'calculate_grades', description: 'Grades', parameters: { type: 'object' as const, properties: { courseId: { type: 'string' } } } }];
const history = [{ role: 'user' as const, content: 'What is my average in SYN10001?' }];

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function stream(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const event of events) { controller.enqueue(encoder.encode(data(event))); await new Promise(resolve => setTimeout(resolve, 1)); }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
/** Mock fetch that answers each request with the next scripted response and records the parsed bodies. */
function script(responses: (Response | (() => Response))[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const next = responses[bodies.length - 1] ?? responses[responses.length - 1]!;
    return typeof next === 'function' ? next() : next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, fetchMock };
}

// DeepSeek Responses steps.
const dsText = (text: string, usage = { input_tokens: 10, output_tokens: 2 }, reasoning = '') => stream([
  ...(reasoning ? [{ type: 'response.reasoning_text.delta', delta: reasoning }] : []),
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: { status: 'completed', usage } },
]);
const dsCalls = (calls: { id: string; name: string; args: string }[], text = '', reasoning = '') => stream([
  ...(reasoning ? [{ type: 'response.reasoning_text.delta', delta: reasoning }] : []),
  ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
  ...calls.map(call => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: call.id, name: call.name, arguments: call.args } })),
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } },
]);
const ok = (name: string, args: unknown) => ({ ok: true, text: JSON.stringify({ name, args }) });

describe('runChatWithTools', () => {
  it('answers in one step without tools', async () => {
    const { bodies } = script([dsText('No tools needed.')]);
    const runTool = vi.fn();
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool }, {});
    expect(result).toMatchObject({ ok: true, text: 'No tools needed.', steps: [], model: 'deepseek-flash', usage: { input: 10, output: 2 } });
    expect(runTool).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.tool_choice).toBe('auto');
  });

  it('runs an Anthropic tool call, sends the tool_result and streams the answer', async () => {
    const { bodies } = script([
      stream([
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'calculate_grades', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"courseId":"syn-1"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ]),
      stream([
        { type: 'message_start', message: { usage: { input_tokens: 150, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Your average is 87.5%.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ]),
    ]);
    const runTool = vi.fn((name: string, args: unknown) => ok(name, args));
    const deltas: string[] = [], events: unknown[] = [];
    const result = await runChatWithTools(anthropic, { system: 'SYS', history, tools, runTool }, { onDelta: text => deltas.push(text), onStep: event => events.push(event) });
    expect(runTool).toHaveBeenCalledWith('calculate_grades', { courseId: 'syn-1' });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Let me check.\n\nYour average is 87.5%.');
    expect(deltas.join('')).toBe(result.text);
    expect(result.usage).toMatchObject({ input: 250, output: 20 });
    expect(result.steps).toEqual([{ name: 'calculate_grades', args: '{"courseId":"syn-1"}', ok: true, result: JSON.stringify({ name: 'calculate_grades', args: { courseId: 'syn-1' } }), ms: expect.any(Number) }]);
    expect(events).toEqual([
      { index: 0, name: 'calculate_grades', args: '{"courseId":"syn-1"}', state: 'running' },
      { index: 0, state: 'done', ok: true, preview: result.steps[0]!.result.slice(0, 200) },
    ]);
    const second = bodies[1] as { messages: { role: string; content: unknown }[] };
    expect(second.messages.at(-2)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu1', name: 'calculate_grades', input: { courseId: 'syn-1' } }] });
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: result.steps[0]!.result }] });
  });

  it('runs parallel DeepSeek calls in order, sends all calls before their outputs, and keeps reasoning', async () => {
    const { bodies } = script([
      dsCalls([{ id: 'c1', name: 'list_courses', args: '' }, { id: 'c2', name: 'calculate_grades', args: '{"courseId":"syn-1"}' }], '', 'Need data. '),
      dsText('Done.', undefined, 'Now answer.'),
    ]);
    const order: string[] = [];
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool: (name: string, args: unknown) => { order.push(name); return ok(name, args); } }, {});
    expect(order).toEqual(['list_courses', 'calculate_grades']);
    expect(result.reasoning).toBe('Need data. \n\nNow answer.');
    const input = (bodies[1] as { input: { type?: string; call_id?: string }[] }).input;
    const types = input.map(item => item.type ?? 'message');
    expect(types).toEqual(['message', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
    expect(input.slice(2).map(item => item.call_id)).toEqual(['c1', 'c2', 'c1', 'c2']);
  });

  it('merges fragmented chat-completions calls and runs an empty-argument call with {}', async () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    script([
      stream([
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: 'courses', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'call_2', function: { name: 'calculate_grades', arguments: '{"cou' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: 'rseId":"syn-1"}' } }] }),
        chunk({}, 'tool_calls'),
      ]),
      stream([chunk({ content: 'Two courses.' }), chunk({}, 'stop'), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }]),
    ]);
    const runTool = vi.fn((name: string, args: unknown) => ok(name, args));
    const result = await runChatWithTools(compatible, { system: 'SYS', history, tools, runTool }, {});
    expect(runTool.mock.calls).toEqual([['list_courses', {}], ['calculate_grades', { courseId: 'syn-1' }]]);
    expect(result).toMatchObject({ ok: true, text: 'Two courses.' });
    expect(result.steps.map(step => step.args)).toEqual(['{}', '{"courseId":"syn-1"}']);
  });

  it('returns malformed arguments to the model as INVALID_ARGUMENTS and continues', async () => {
    const { bodies } = script([dsCalls([{ id: 'c1', name: 'calculate_grades', args: '{"courseId": ' }]), dsText('Retried.')]);
    const runTool = vi.fn();
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool }, {});
    expect(runTool).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ name: 'calculate_grades', ok: false });
    expect(JSON.parse(result.steps[0]!.result).error.code).toBe('INVALID_ARGUMENTS');
    const output = (bodies[1] as { input: { type?: string; output?: string }[] }).input.find(item => item.type === 'function_call_output');
    expect(output?.output).toBe(result.steps[0]!.result);
  });

  it('sends the eighth request with tool choice none and ends with an error if the model still calls a tool', async () => {
    const { bodies } = script([() => dsCalls([{ id: `c${Math.random()}`, name: 'list_courses', args: '' }], 'Step.')]);
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool: (name: string, args: unknown) => ok(name, args) }, {});
    expect(bodies).toHaveLength(TOOL_LOOP_LIMITS.requests);
    expect(bodies.slice(0, 7).every(body => body.tool_choice === 'auto')).toBe(true);
    expect(bodies[7]!.tool_choice).toBe('none');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('模型没有在步数内给出回答。');
    expect(result.text).toContain('Step.');
    expect(result.steps).toHaveLength(7);
  });

  it('refuses calls beyond 16 with TOOL_BUDGET_EXHAUSTED and then forces tool choice none', async () => {
    const five = (round: number) => dsCalls(Array.from({ length: 5 }, (_, index) => ({ id: `r${round}c${index}`, name: 'list_courses', args: '' })));
    const { bodies } = script([five(1), five(2), five(3), five(4), dsText('Answer.')]);
    const runTool = vi.fn((name: string, args: unknown) => ok(name, args));
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool }, {});
    expect(runTool).toHaveBeenCalledTimes(16);
    expect(result.steps).toHaveLength(16);
    const outputs = (bodies[4] as { input: { type?: string; output?: string }[] }).input.filter(item => item.type === 'function_call_output');
    expect(outputs).toHaveLength(20);
    expect(outputs.slice(16).every(item => JSON.parse(item.output!).error.code === 'TOOL_BUDGET_EXHAUSTED')).toBe(true);
    expect(bodies[3]!.tool_choice).toBe('auto');
    expect(bodies[4]!.tool_choice).toBe('none');
    expect(result).toMatchObject({ ok: true, text: 'Answer.' });
  });

  it('caps all tool results of one reply at 40 000 characters', async () => {
    const calls = (round: number) => dsCalls(Array.from({ length: 3 }, (_, index) => ({ id: `r${round}c${index}`, name: 'list_courses', args: '' })));
    const { bodies } = script([calls(1), calls(2), dsText('Answer.')]);
    const big = 'x'.repeat(7000);
    const runTool = vi.fn(() => ({ ok: true, text: big }));
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool }, {});
    const outputs = (bodies[2] as { input: { type?: string; output?: string }[] }).input.filter(item => item.type === 'function_call_output');
    expect(outputs.slice(0, 5).every(item => item.output === big)).toBe(true);
    expect(JSON.parse(outputs[5]!.output!).error.code).toBe('TOOL_BUDGET_EXHAUSTED');
    expect(outputs.reduce((sum, item) => sum + item.output!.length, 0)).toBeLessThanOrEqual(TOOL_LOOP_LIMITS.resultChars + 1000);
    expect(bodies[2]!.tool_choice).toBe('none');
    expect(result.ok).toBe(true);
  });

  it('keeps the text and steps so far when stopped mid-loop', async () => {
    const controller = new AbortController();
    const { fetchMock } = script([dsCalls([{ id: 'c1', name: 'list_courses', args: '' }], 'Checking.'), dsText('never')]);
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool: (name: string, args: unknown) => { controller.abort(); return ok(name, args); } }, { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, stopped: true, text: 'Checking.' });
    expect(result.steps).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ends with the provider error on a later step and keeps partial text, steps and usage', async () => {
    script([dsCalls([{ id: 'c1', name: 'list_courses', args: '' }], 'Checking.'), new Response(JSON.stringify({ error: { message: 'tools overloaded sk-test-ds' } }), { status: 400 })]);
    const result = await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool: (name: string, args: unknown) => ok(name, args) }, {});
    expect(result).toMatchObject({ ok: false, text: 'Checking.', usage: { input: 10, output: 3 } });
    expect(result.toolsRejected).toBeFalsy();
    expect(result.error).toContain('400');
    expect(result.error).not.toContain('sk-test-ds');
    expect(result.steps).toHaveLength(1);
  });

  it('flags a first-request openai-compatible rejection that is about tools', async () => {
    script([new Response(JSON.stringify({ error: { message: 'tools is not supported for this model' } }), { status: 400 })]);
    const result = await runChatWithTools(compatible, { system: 'SYS', history, tools, runTool: vi.fn() }, {});
    expect(result).toMatchObject({ ok: false, toolsRejected: true });
    script([new Response(JSON.stringify({ error: { message: 'tools is not supported for this model' } }), { status: 400 })]);
    expect((await runChatWithTools(deepseek, { system: 'SYS', history, tools, runTool: vi.fn() }, {})).toolsRejected).toBeFalsy();
    script([new Response(JSON.stringify({ error: { message: 'Missing reasoning_content in assistant message' } }), { status: 400 })]);
    expect((await runChatWithTools(compatible, { system: 'SYS', history, tools, runTool: vi.fn() }, {})).toolsRejected).toBeFalsy();
  });

  it('sums usage only over steps that reported it', async () => {
    const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
    script([
      stream([chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'list_courses', arguments: '{}' } }] }), chunk({}, 'tool_calls')]),
      stream([chunk({ content: 'Fine.' }), chunk({}, 'stop')]),
    ]);
    const none = await runChatWithTools(compatible, { system: 'SYS', history, tools, runTool: (name: string, args: unknown) => ok(name, args) }, {});
    expect(none.usage).toBeNull();
  });
});

describe('rejectsTools', () => {
  it('matches only 400/404/422 errors about tools that do not mention reasoning', () => {
    expect(rejectsTools(400, 'tools is not supported for this model')).toBe(true);
    expect(rejectsTools(422, '{"detail":"tool_choice is not allowed"}')).toBe(true);
    expect(rejectsTools(404, 'function calling not available')).toBe(true);
    expect(rejectsTools(400, 'function_call unsupported')).toBe(true);
    expect(rejectsTools(400, 'reasoning_content is required for tool calls')).toBe(false);
    expect(rejectsTools(400, 'invalid model')).toBe(false);
    expect(rejectsTools(500, 'tools is not supported')).toBe(false);
    expect(rejectsTools(401, 'tools')).toBe(false);
  });
});
