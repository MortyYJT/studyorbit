import { z } from 'zod';
import { AgentEventSchema } from '../../src/agent/adapter.js';
import type { Conversation, Message } from '../../src/domain/schemas.js';

export const StoredEventSchema = z.object({ id: z.string().min(1), messageId: z.string().min(1),
  event: z.union([AgentEventSchema, z.object({ type: z.literal('stopped') })]) });
export type StoredEvent = z.infer<typeof StoredEventSchema>;
export interface Opened { conversation: Conversation; messages: Message[]; events: StoredEvent[] }
export interface ChatState extends Opened { cursor?: string; running: boolean }
/** Navigation payload other views use to open the Agent page with a preset prompt. */
export interface AgentPreset { id: string; courseId?: string; assessmentId?: string; title?: string }
export type ChatItem =
  | { kind: 'owner'; id: string; text: string; preset: boolean }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'step'; id: string; tool: string; outcome: 'ok' | 'error' | 'denied' | 'waiting'; screenshotRef?: string; tabId?: string; reason?: string }
  | { kind: 'confirmation'; id: string; confirmationId: string; decision: 'pending' | 'confirmed' | 'cancelled' | 'expired' }
  | { kind: 'stopped'; id: string }
  | { kind: 'error'; id: string; code: 'AGENT_UNAVAILABLE' | 'INTERNAL' };

/** Incremental SSE parser; frames whose data is not a stored chat event are dropped. */
export function sseParser(): (chunk: string) => StoredEvent[] {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    // Hold a trailing CR: its LF may arrive in the next chunk.
    const held = buffer.endsWith('\r') ? '\r' : '';
    const text = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
    const frames = text.split('\n\n');
    buffer = frames.pop()! + held;
    return frames.flatMap(frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
      if (!data.length) return [];
      try { const parsed = StoredEventSchema.safeParse(JSON.parse(data.join('\n'))); return parsed.success ? [parsed.data] : []; }
      catch { return []; }
    });
  };
}
const terminal = (event: StoredEvent['event']) => event.type === 'result' || event.type === 'error' || event.type === 'stopped';
function settle(value: Opened): ChatState {
  const last = [...value.messages].sort((a, b) => a.seq - b.seq).at(-1);
  const unknown = value.events.filter(e => !value.messages.some(m => m.id === e.messageId)).at(-1)?.messageId;
  const replyId = unknown ?? (last?.role === 'agent' && !last.stopped ? last.id : undefined);
  const running = !!replyId && !value.events.some(e => e.messageId === replyId && terminal(e.event));
  return { ...value, cursor: value.events.at(-1)?.id, running };
}
/** Applies streamed events once each, in arrival order; the cursor is the last applied id. */
export function applyEvents(state: ChatState, events: StoredEvent[]): ChatState {
  const seen = new Set(state.events.map(e => e.id));
  const fresh = events.filter(e => !seen.has(e.id) && seen.add(e.id));
  return fresh.length ? settle({ ...state, events: [...state.events, ...fresh] }) : state;
}
/** A reopened snapshot replaces the transcript but keeps events streamed after it was taken. */
export function fromOpen(previous: ChatState | undefined, opened: Opened): ChatState {
  const state = settle(opened);
  return previous?.conversation.id === opened.conversation.id ? applyEvents(state, previous.events) : state;
}
const viewPath = /^\/api\/browser\.view\?tabId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
function replyItems(events: StoredEvent[], decisions: Map<string, ChatItem & { kind: 'confirmation' }>): ChatItem[] {
  const items: ChatItem[] = [];
  for (const { id, event } of events) {
    const previous = items.at(-1);
    if (event.type === 'text') {
      if (previous?.kind === 'text') previous.text += event.text; else items.push({ kind: 'text', id, text: event.text });
    } else if (event.type === 'tool_step') {
      const tabId = event.viewUrl ? viewPath.exec(event.viewUrl)?.[1] : undefined;
      items.push({ kind: 'step', id, tool: event.tool, outcome: event.outcome, ...(event.screenshotRef ? { screenshotRef: event.screenshotRef } : {}),
        ...(tabId ? { tabId } : {}), ...(typeof event.output === 'string' && event.outcome !== 'ok' ? { reason: event.output } : {}) });
    } else if (event.type === 'confirmation') {
      const known = decisions.get(event.confirmationId);
      if (known) known.decision = event.decision ?? 'pending';
      else { const item = { kind: 'confirmation' as const, id, confirmationId: event.confirmationId, decision: event.decision ?? 'pending' }; decisions.set(event.confirmationId, item); items.push(item); }
    } else if (event.type === 'stopped') items.push({ kind: 'stopped', id });
    else if (event.type === 'error') items.push({ kind: 'error', id, code: event.code });
  }
  return items;
}
/** Owner prompts from the transcript; agent replies from the event journal, which also holds errors and stops. */
export function chatItems(state: ChatState): ChatItem[] {
  const decisions = new Map<string, ChatItem & { kind: 'confirmation' }>();
  const messages = [...state.messages].sort((a, b) => a.seq - b.seq);
  const of = (id: string) => state.events.filter(e => e.messageId === id);
  const items = messages.flatMap((message, index): ChatItem[] => message.role === 'owner'
    ? [{ kind: 'owner', id: message.id, preset: index === 0 && !!state.conversation.preset,
      text: message.parts.map(part => part.type === 'text' ? part.text : '').join('') }]
    : replyItems(of(message.id), decisions));
  const unknown = [...new Set(state.events.map(e => e.messageId))].filter(id => !messages.some(m => m.id === id));
  return [...items, ...unknown.flatMap(id => replyItems(of(id), decisions))];
}
export function pendingConfirmations(state: ChatState): string[] {
  return chatItems(state).flatMap(item => item.kind === 'confirmation' && item.decision === 'pending' ? [item.confirmationId] : []);
}
const fatal = new Set(['NOT_FOUND', 'INVALID_INPUT', 'OWNER_SESSION_EXPIRED']);
/** Keeps one stream open, reconnecting from the last applied event id until aborted or the conversation is gone. */
export async function runStream(options: { connect(after: string | undefined, signal: AbortSignal): AsyncIterable<StoredEvent>; cursor(): string | undefined;
  onEvents(events: StoredEvent[]): void; signal: AbortSignal; delay(ms: number): Promise<void> }): Promise<void> {
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      for await (const event of options.connect(options.cursor(), options.signal)) {
        if (options.signal.aborted) return;
        options.onEvents([event]); failures = 0;
      }
    } catch (error) { if (fatal.has((error as { code?: string }).code ?? '')) return; }
    if (options.signal.aborted) return;
    await options.delay(Math.min(15000, 500 * 2 ** failures++));
  }
}
const launched = new WeakMap<AgentPreset, Promise<Conversation>>();
/** One create per navigation payload; the backend sends the rendered prompt as part of create. */
export function launchPresetOnce(preset: AgentPreset, create: (preset: AgentPreset) => Promise<Conversation>): Promise<Conversation> {
  let pending = launched.get(preset);
  if (!pending) { pending = create(preset); launched.set(preset, pending); }
  return pending;
}
