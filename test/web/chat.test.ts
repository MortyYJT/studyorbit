import { describe, expect, it, vi } from 'vitest';
import { applyEvents, chatItems, unlinkedConfirmations, fromOpen, launchPresetOnce, pendingConfirmations, runStream, sseParser, type Opened, type StoredEvent } from '../../web/src/chat.js';

const at = '2026-10-20T10:00:00.000Z';
const conversation = { id: 'c-1', title: 'Quiz 3', adapter: 'synthetic', preset: 'complete-assessment', createdAt: at, updatedAt: at };
const owner = { id: 'm-0', conversationId: 'c-1', seq: 0, role: 'owner' as const, parts: [{ type: 'text' as const, text: 'Complete the assessment.' }], stopped: false, at };
const agent = { id: 'm-1', conversationId: 'c-1', seq: 1, role: 'agent' as const, parts: [], stopped: false, at };
const ev = (index: number, event: StoredEvent['event'], messageId = 'm-1', seq = 1): StoredEvent => ({ id: `${seq}:${index}`, messageId, event });
const opened = (events: StoredEvent[] = []): Opened => ({ conversation, messages: [owner, agent], events });

describe('agent chat stream state', () => {
  it('parses SSE frames split across chunks and ignores keepalive comments', () => {
    const parse = sseParser();
    const frame = `id: 1:0\nevent: text\ndata: ${JSON.stringify(ev(0, { type: 'text', text: 'Hi' }))}\n\n`;
    expect(parse(': keepalive\n\n' + frame.slice(0, 20))).toEqual([]);
    expect(parse(frame.slice(20) + 'id: 1:1\nda')).toEqual([ev(0, { type: 'text', text: 'Hi' })]);
    expect(parse(`ta: ${JSON.stringify(ev(1, { type: 'stopped' }))}\r\n\r\n`)).toEqual([ev(1, { type: 'stopped' })]);
    expect(parse('id: 1:2\ndata: {"not":"an event"}\n\n')).toEqual([]);
  });
  it('reconnects from the last event id after a drop and applies no event twice', async () => {
    const all = Array.from({ length: 8 }, (_, i) => ev(i, i === 7 ? { type: 'result', turns: 2 } : { type: 'text', text: `t${i}` }));
    const cursors: (string | undefined)[] = [];
    let state = fromOpen(undefined, opened());
    const controller = new AbortController();
    const connect = vi.fn(async function* (after?: string) {
      cursors.push(after);
      if (cursors.length === 1) { yield* all.slice(0, 5); throw new Error('dropped'); }
      // A server replay that overlaps the client's cursor must not duplicate.
      yield* all.slice(4); controller.abort();
    });
    await runStream({ connect, cursor: () => state.cursor, onEvents: events => { state = applyEvents(state, events); }, signal: controller.signal, delay: async () => {} });
    expect(cursors).toEqual([undefined, '1:4']);
    expect(state.events.map(e => e.id)).toEqual(all.map(e => e.id));
    expect(chatItems(state).filter(i => i.kind === 'text').map(i => i.kind === 'text' && i.text)).toEqual(['t0t1t2t3t4t5t6']);
    expect(state.running).toBe(false);
  });
  it('stops retrying when the conversation or owner session is gone', async () => {
    const connect = vi.fn(async function* (): AsyncGenerator<StoredEvent> { throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' }); });
    await runStream({ connect, cursor: () => undefined, onEvents: () => {}, signal: new AbortController().signal, delay: async () => {} });
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('merges a reopened conversation without dropping streamed events', () => {
    const streamed = applyEvents(fromOpen(undefined, opened()), [ev(0, { type: 'text', text: 'a' }), ev(1, { type: 'text', text: 'b' })]);
    const merged = fromOpen(streamed, opened([ev(0, { type: 'text', text: 'a' })]));
    expect(merged.events.map(e => e.id)).toEqual(['1:0', '1:1']);
    expect(merged.cursor).toBe('1:1');
    expect(merged.running).toBe(true);
  });
});
describe('agent chat view model', () => {
  it('shows the preset prompt, streamed text, tool steps with screenshots and Edge links, denied steps and the stopped marker', () => {
    const tab = 'b5f2a1d0-1111-4111-8111-111111111111'; const shot = 'b5f2a1d0-2222-4222-8222-222222222222';
    const state = fromOpen(undefined, opened([
      ev(0, { type: 'text', text: 'Opening ' }), ev(1, { type: 'text', text: 'the quiz.' }),
      ev(2, { type: 'tool_step', tool: 'browser.screenshot', outcome: 'ok', screenshotRef: shot, viewUrl: `/api/browser.view?tabId=${tab}` }),
      ev(3, { type: 'tool_step', tool: 'Bash', outcome: 'denied', output: 'Owner commands are refused.' }),
      ev(4, { type: 'tool_step', tool: 'browser.open', outcome: 'ok', viewUrl: 'https://example.test/elsewhere' }),
      ev(5, { type: 'stopped' }),
    ]));
    expect(chatItems(state)).toEqual([
      { kind: 'owner', id: 'm-0', text: 'Complete the assessment.', preset: true },
      { kind: 'text', id: '1:0', text: 'Opening the quiz.' },
      { kind: 'step', id: '1:2', tool: 'browser.screenshot', outcome: 'ok', screenshotRef: shot, tabId: tab },
      { kind: 'step', id: '1:3', tool: 'Bash', outcome: 'denied', reason: 'Owner commands are refused.' },
      { kind: 'step', id: '1:4', tool: 'browser.open', outcome: 'ok' },
      { kind: 'stopped', id: '1:5' },
    ]);
    expect(state.running).toBe(false);
  });
  it('shows a reply whose message is not yet in the opened transcript, and an agent error code', () => {
    const state = applyEvents(fromOpen(undefined, { conversation, messages: [], events: [] }), [ev(0, { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in.' }, 'm-9', 3)]);
    expect(chatItems(state)).toEqual([{ kind: 'error', id: '3:0', code: 'AGENT_UNAVAILABLE' }]);
  });
  it('tracks the latest decision of each confirmation in the conversation', () => {
    const state = fromOpen(undefined, opened([
      ev(0, { type: 'confirmation', confirmationId: 'p-1', decision: 'pending' }), ev(1, { type: 'confirmation', confirmationId: 'p-1', decision: 'cancelled' }),
      ev(2, { type: 'confirmation', confirmationId: 'p-2', decision: 'pending' }),
    ]));
    expect(pendingConfirmations(state)).toEqual(['p-2']);
    const row = (id: string, conversationId = 'c-1') => ({ id, conversationId, assessmentId: 'a-1', summary: 'Answers', screenshotRef: 's', state: 'pending' as const, createdAt: at });
    // A pending record of this conversation without a journal event (e.g. recorded by an external tool scope) still shows.
    expect(unlinkedConfirmations(state, [row('p-2'), row('p-3'), row('p-4', 'c-other')]).map(r => r.id)).toEqual(['p-3']);
    expect(chatItems(state).filter(i => i.kind === 'confirmation')).toEqual([
      { kind: 'confirmation', id: '1:0', confirmationId: 'p-1', decision: 'cancelled' },
      { kind: 'confirmation', id: '1:2', confirmationId: 'p-2', decision: 'pending' },
    ]);
  });
});
describe('agent presets', () => {
  it('creates the preset conversation once even when the page asks twice', async () => {
    const create = vi.fn(async () => conversation);
    const preset = { id: 'tutor-revision', courseId: 'c-1' };
    const [first, second] = await Promise.all([launchPresetOnce(preset, create), launchPresetOnce(preset, create)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});
