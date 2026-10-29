import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';
import type { CourseDocument } from '../shared/course-data.js';

// One chat reply as the route runs it (decisions #323, #326, #328): mode choice, prompt, history, fallback and the
// message that is saved. Provider HTTP and the Codex process are faked. Synthetic data only.
const spawnMock = vi.fn();
vi.mock('node:child_process', async original => ({ ...(await original<typeof import('node:child_process')>()), spawn: (...args: unknown[]) => spawnMock(...args) }));
const { runChatReply, replyHistory, REASONING_LIMIT } = await import('../scripts/lib/chat-reply.mjs');
const { buildChatContext, chatSystemPrompt } = await import('../scripts/lib/chat-context.mjs');

afterEach(() => { vi.unstubAllGlobals(); spawnMock.mockReset(); });

type Item = Extract<CourseDocument, { version: 2 }>['assessments'][number];
const item = (patch: Partial<Item> & { id: string; name: string }): Item => ({
  kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: null,
  status: 'unknown', scoring: 'none', rule: null, sources: [], refs: [], weightQuote: null, ruleQuote: null, unsourced: [], ...patch,
});
const synthetic: CourseDocument = {
  version: 2, course: { id: 'syn-1', code: 'SYN10001', name: 'Synthetic Systems', term: '2026 Semester 2' }, materials: [], legacyIds: {},
  assessments: [item({ id: 'a1', name: 'Assignment Zeta', weight: 40, score: 35, maxScore: 40, status: 'graded' }), item({ id: 'exam', name: 'Final exam', kind: 'test', weight: 60 })],
};
const base = { documents: [synthetic], courses: [{ id: 'syn-2', code: 'SYN20002', name: 'Synthetic Data' }], scope: ['syn-1'], today: '2026-09-14', language: 'zh' as const, planning: null };
const at = '2026-09-14T00:00:00.000Z';
const user = (content: string) => ({ role: 'user' as const, content, at });

const deepseek: AnalysisConfig = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: null, apiKey: 'sk-test-ds' };
const compatible: AnalysisConfig = { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: 'https://llm.example/v1/chat/completions', apiKey: 'sk-test-oc' };
const anthropic: AnalysisConfig = { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: null, apiKey: 'sk-test-an' };

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const stream = (events: unknown[]) => new Response(events.map(data).join(''), { headers: { 'content-type': 'text/event-stream' } });
function script(responses: Response[]) {
  const bodies: Record<string, any>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return responses[bodies.length - 1]!; }));
  return bodies;
}
const dsCall = (name: string, args: string, reasoning = 'Look it up.') => stream([
  { type: 'response.reasoning_text.delta', delta: reasoning },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name, arguments: args } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } } },
]);
const dsText = (text: string, reasoning = 'Answer now.') => stream([
  { type: 'response.reasoning_text.delta', delta: reasoning },
  { type: 'response.output_text.delta', delta: text },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 4 } } },
]);

describe('runChatReply in tool mode', () => {
  it('sends the tool prompt with the course index and registry tools, and saves steps, mode and reasoning', async () => {
    const bodies = script([dsCall('calculate_grades', '{"courseId":"syn-1"}'), dsText('平均 87.5%。')]);
    const steps: unknown[] = [];
    const reply = await runChatReply({ config: deepseek, messages: [user('我的平均分？')], ...base }, { onStep: event => steps.push(event) });
    expect(reply.ok).toBe(true);
    const first = bodies[0]!;
    expect(first.instructions.startsWith(chatSystemPrompt('zh', 'tools'))).toBe(true);
    expect(first.instructions).toContain('SYN10001');
    expect(first.instructions).not.toContain('Assignment Zeta');
    expect(first.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_courses', 'get_assessments', 'calculate_grades', 'final_needed', 'upcoming_deadlines', 'plan_schedule']);
    expect(reply.message).toMatchObject({ role: 'assistant', content: '平均 87.5%。', mode: 'tools', model: 'deepseek-flash', reasoning: 'Look it up.\n\nAnswer now.' });
    expect(reply.message!.steps).toHaveLength(1);
    expect(JSON.parse(reply.message!.steps![0]!.result)).toMatchObject({ courseId: 'syn-1', average: 87.5 });
    expect(reply.message!.status).toBeUndefined();
    expect(reply.message!.fallback).toBeUndefined();
    expect(steps).toHaveLength(2);
  });

  it('plans with the sent snapshot and never puts the snapshot itself in the saved message', async () => {
    const planning = { tasks: [
      { key: 'syn-1:a1', title: 'Synthetic task one', courseId: 'syn-1', courseCode: 'SYN10001', due: '2026-09-16', minutes: 60 },
      { key: 'syn-9:x', title: 'Other course task', courseId: 'syn-9', courseCode: 'SYN90009', due: '2026-09-15', minutes: 30 },
      { key: 'personal:1', title: 'Personal errand', courseId: '', courseCode: '', due: '2026-09-17', minutes: 45 },
    ], availability: [60, 60, 60, 60, 60, 60, 60], targets: { 'syn-1': 'H2A' as const } };
    script([dsCall('plan_schedule', ''), dsText('排好了。')]);
    const reply = await runChatReply({ config: deepseek, messages: [user('这周怎么安排？')], ...base, planning }, {});
    const result = JSON.parse(reply.message!.steps![0]!.result);
    expect(result).toMatchObject({ available: true, tasksSource: 'snapshot', availabilitySource: 'snapshot' });
    // The other course's task takes Monday's first 30 minutes, exactly as on the weekly page, but is not shown.
    expect(result.days['2026-09-14']).toEqual([{ key: 'syn-1:a1', title: 'Synthetic task one', courseCode: 'SYN10001', minutes: 30 }]);
    expect(JSON.stringify(reply.message)).not.toContain('Other course task');
    expect(JSON.stringify(reply.message)).not.toContain('"availability"');
    expect(JSON.stringify(reply.message)).not.toContain('H2A');
  });

  it('drops reasoning longer than the limit instead of cutting it', async () => {
    script([dsText('ok', 'r'.repeat(REASONING_LIMIT + 1))]);
    const reply = await runChatReply({ config: deepseek, messages: [user('hi')], ...base }, {});
    expect(reply.message!.reasoning).toBeUndefined();
    expect(reply.message!.mode).toBe('tools');
  });

  it('stores no reasoning for Anthropic', async () => {
    script([stream([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret plan' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    ])]);
    const reply = await runChatReply({ config: anthropic, messages: [user('hi')], ...base }, {});
    expect(reply.message).toMatchObject({ content: 'Hello.', mode: 'tools' });
    expect(reply.message!.reasoning).toBeUndefined();
    expect(reply.message!.steps).toBeUndefined();
  });

  it('replays stored reasoning on the second DeepSeek turn and folds older turns without reasoning', async () => {
    const bodies = script([dsText('second')]);
    await runChatReply({ config: deepseek, messages: [
      user('Q0'), { role: 'assistant', content: 'A0 from context mode', at },
      user('Q1'), { role: 'assistant', content: 'A1', at, mode: 'tools', reasoning: 'stored thought' },
      user('Q2'),
    ], ...base }, {});
    expect(bodies[0]!.input).toEqual([
      { role: 'user', content: expect.stringMatching(/之前的对话[\s\S]*Q0[\s\S]*A0 from context mode[\s\S]*Q1$/) },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'stored thought' }] },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ]);
  });

  it('keeps partial text and steps when stopped', async () => {
    const controller = new AbortController();
    script([dsCall('list_courses', ''), dsText('never')]);
    const reply = await runChatReply({ config: deepseek, messages: [user('hi')], ...base }, { signal: controller.signal, onStep: event => { if ((event as { state: string }).state === 'done') controller.abort(); } });
    expect(reply.stopped).toBe(true);
    expect(reply.message).toMatchObject({ status: 'stopped', mode: 'tools', content: '' });
    expect(reply.message!.steps).toHaveLength(1);
  });
});

describe('openai-compatible fallback', () => {
  it('retries once in context mode when the first request is rejected for tools', async () => {
    const bodies = script([
      new Response(JSON.stringify({ error: { message: 'tools is not supported for this model' } }), { status: 400 }),
      stream([{ choices: [{ delta: { content: '按上下文回答。' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
    ]);
    const reply = await runChatReply({ config: compatible, messages: [user('平均分？')], ...base }, {});
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[1]!.messages[0].content).toBe(`${chatSystemPrompt('zh')}\n\n# 课程数据\n\n${buildChatContext([synthetic], { today: '2026-09-14', courseIds: ['syn-1'], courses: base.courses })}`);
    expect(reply.ok).toBe(true);
    expect(reply.message).toMatchObject({ content: '按上下文回答。', mode: 'context', fallback: true });
    expect(reply.message!.steps).toBeUndefined();
  });

  it('continues an old chat with stored reasoning without sending a reasoning-less assistant turn', async () => {
    const bodies = script([stream([{ choices: [{ delta: { reasoning_content: 'r2', content: 'Fine.' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])]);
    const reply = await runChatReply({ config: compatible, messages: [
      user('Q0'), { role: 'assistant', content: 'A0 from context mode', at },
      user('Q1'), { role: 'assistant', content: 'A1', at, mode: 'tools', reasoning: 'stored thought' },
      user('Q2'),
    ], ...base }, {});
    const messages = bodies[0]!.messages as { role: string; content: string; reasoning_content?: string }[];
    expect(messages.filter(message => message.role === 'assistant')).toEqual([{ role: 'assistant', content: 'A1', reasoning_content: 'stored thought' }]);
    expect(messages[1]!.content).toMatch(/之前的对话[\s\S]*A0 from context mode[\s\S]*Q1$/);
    expect(reply.message).toMatchObject({ content: 'Fine.', reasoning: 'r2' });
  });

  it('shows a 400 about reasoning as an error without falling back', async () => {
    const bodies = script([new Response(JSON.stringify({ error: { message: 'Missing reasoning_content field in the assistant message at index 1' } }), { status: 400 })]);
    const reply = await runChatReply({ config: compatible, messages: [user('hi')], ...base }, {});
    expect(bodies).toHaveLength(1);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('reasoning_content');
    expect(reply.message).toBeNull();
  });
});

describe('Codex keeps context mode', () => {
  it('sends the pinned context-mode prompt and saves no steps', async () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number };
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough(); proc.pid = 0;
    let prompt = '';
    proc.stdin.on('data', chunk => { prompt += chunk; });
    setTimeout(() => {
      proc.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex answer' } })}\n`);
      proc.stdout.end(); setTimeout(() => proc.emit('close', 0), 5);
    }, 5);
    spawnMock.mockReturnValue(proc);
    const reply = await runChatReply({ config: { provider: 'codex', model: 'gpt-6-luna', baseUrl: null, apiKey: null }, messages: [user('平均分？')], ...base }, {});
    const system = `${chatSystemPrompt('zh')}\n\n# 课程数据\n\n${buildChatContext([synthetic], { today: '2026-09-14', courseIds: ['syn-1'], courses: base.courses })}`;
    expect(prompt.startsWith(`${system}\n\n# 对话记录\n\n用户：\n平均分？`)).toBe(true);
    expect(reply.message).toMatchObject({ content: 'Codex answer', mode: 'context' });
    expect(reply.message!.steps).toBeUndefined();
    expect(reply.message!.fallback).toBeUndefined();
  });
});

describe('replyHistory', () => {
  const long = 'r'.repeat(59997);
  const messages = [user('Q1'), { role: 'assistant' as const, content: 'A1', at, reasoning: long }, user('Q2')];
  it('counts stored reasoning against the 60 000-character budget when it is replayed', () => {
    expect(replyHistory(messages, { reasoning: true })).toEqual([{ role: 'user', content: 'Q2' }]);
  });
  it('ignores and strips reasoning when it is not replayed', () => {
    expect(replyHistory(messages, { reasoning: false })).toEqual([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }]);
  });
});
