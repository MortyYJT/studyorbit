import { randomUUID } from 'node:crypto';
import type { Conversation, Message, Run } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import type { OwnerInteraction } from '../protocol/context.js';
import { CourseworkError } from '../protocol/errors.js';
import { AgentEventSchema, type AgentEvent, type AgentAdapter, type AgentRun, type AgentTool, type StoredEvent, type StreamEvent } from './adapter.js';
import { presets, renderPreset, type ConversationInput } from './presets.js';

type ChatStore = Pick<SqliteRepository, 'readConversations' | 'readMessages' | 'saveChat' | 'deleteConversation' | 'readChatEvents' | 'loadCourse' | 'loadAssessment'>;
interface ActiveReply { run?: AgentRun; message: Message; conversation: Conversation; events: StoredEvent[]; done: Promise<void>; finish(): void; terminal: boolean }
const now = () => new Date().toISOString();
const terminal = (event: StreamEvent) => ['result', 'error', 'stopped'].includes(event.type);
/** Persists before fan-out; listeners never drive execution or own reply lifetime. */
export class ConversationService {
  private readonly active = new Map<string, ActiveReply>();
  private readonly listeners = new Map<string, Set<(event: StoredEvent) => void>>();
  private readonly deleting = new Set<string>();
  constructor(private readonly store: ChatStore, private readonly adapter: AgentAdapter, private readonly tools: readonly AgentTool[] = []) {}
  /** Mark partial replies of a previous host process stopped. Only the owner UI host, which alone runs replies, calls this at startup. */
  recoverInterrupted(): void {
    for (const conversation of this.store.readConversations()) {
      for (const message of this.store.readMessages(conversation.id).filter(m => m.role === 'agent')) {
        if (this.active.get(conversation.id)?.message.id === message.id) continue;
        const events = this.store.readChatEvents(conversation.id).filter(e => e.messageId === message.id);
        if (events.some(e => terminal(e.event))) continue;
        const reply: ActiveReply = { conversation, message, events, done: Promise.resolve(), finish() {}, terminal: false };
        this.commit(reply, { type: 'stopped' });
      }
    }
  }
  private async owner(owner?: OwnerInteraction) {
    if (!owner) throw new CourseworkError('INVALID_INPUT', 'Owner session required.');
    await owner.assertOwner('agent.chat');
  }
  availablePresets(input: Omit<ConversationInput, 'preset' | 'title'>) {
    renderPreset(this.store, input);
    if (!input.courseId || input.assessmentId && this.store.loadAssessment(input.assessmentId)?.kind === 'exam') return [];
    return presets.filter(preset => !preset.assessment || input.assessmentId).map(preset => ({
      id: preset.id, prompt: renderPreset(this.store, { ...input, preset: preset.id })!,
    }));
  }
  list(): Conversation[] {
    return this.store.readConversations().reverse().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  open(id: string): { conversation: Conversation; messages: Message[]; events: StoredEvent[] } {
    const conversation = this.store.readConversations().find(c => c.id === id);
    if (!conversation) throw new CourseworkError('NOT_FOUND', 'Conversation not found.');
    return { conversation, messages: this.store.readMessages(id).sort((a, b) => a.seq - b.seq), events: this.store.readChatEvents(id) };
  }
  async create(input: ConversationInput, owner?: OwnerInteraction): Promise<Conversation> {
    await this.owner(owner);
    const prompt = renderPreset(this.store, input);
    const at = now();
    const conversation: Conversation = { id: randomUUID(), title: input.title ?? input.preset ?? 'New conversation', adapter: this.adapter.id,
      courseId: input.courseId, assessmentId: input.assessmentId, preset: input.preset, createdAt: at, updatedAt: at };
    this.store.saveChat(conversation);
    if (prompt) await this.send(conversation.id, prompt, owner);
    return this.open(conversation.id).conversation;
  }
  async delete(id: string, owner?: OwnerInteraction): Promise<void> {
    await this.owner(owner); this.open(id);
    // Exclude sends for the whole delete, so no reply can be created after the stop check and rebuild the conversation.
    if (this.deleting.has(id)) throw new CourseworkError('LOCKED', 'Conversation is being deleted.');
    this.deleting.add(id);
    try {
      await this.stop(id, owner);
      this.store.deleteConversation(id);
      this.listeners.delete(id);
    } finally { this.deleting.delete(id); }
  }
  async send(id: string, prompt: string, owner?: OwnerInteraction): Promise<{ messageId: string }> {
    await this.owner(owner);
    if (!prompt.trim() || prompt.length > 65536) throw new CourseworkError('INVALID_INPUT', 'A bounded nonempty prompt is required.');
    if (this.active.has(id) || this.deleting.has(id)) throw new CourseworkError('LOCKED', 'A reply is already running.');
    const { conversation, messages } = this.open(id);
    // The stored transcript is the memory (#177): another adapter's session reference is dropped, never passed on.
    if (conversation.adapter !== this.adapter.id) { conversation.adapter = this.adapter.id; delete conversation.sessionRef; }
    const at = now(); const seq = (messages.at(-1)?.seq ?? -1) + 1;
    conversation.updatedAt = at;
    this.store.saveChat(conversation, { id: randomUUID(), conversationId: id, seq, role: 'owner', parts: [{ type: 'text', text: prompt }], stopped: false, at });
    let finish!: () => void;
    const reply: ActiveReply = { conversation, message: { id: randomUUID(), conversationId: id, seq: seq + 1, role: 'agent', parts: [], stopped: false, at },
      events: [], done: new Promise(resolve => { finish = resolve; }), finish: () => finish(), terminal: false };
    this.store.saveChat(conversation, reply.message, []);
    this.active.set(id, reply);
    // Scheduling permits the send response to return before the adapter starts work.
    setImmediate(() => { void this.consume(reply, prompt, messages); });
    return { messageId: reply.message.id };
  }
  private async consume(reply: ActiveReply, prompt: string, transcript: Message[]): Promise<void> {
    try {
      if (reply.terminal) return;
      const c = reply.conversation;
      reply.run = this.adapter.start({ prompt, transcript, tools: this.tools, sessionRef: c.sessionRef, courseId: c.courseId, assessmentId: c.assessmentId, preset: c.preset });
      for await (const raw of reply.run) {
        if (reply.terminal) break;
        const event = AgentEventSchema.parse(raw);
        // Never persist raw adapter diagnostics, which can contain credentials or local paths.
        this.commit(reply, event.type === 'error' ? { ...event, message: event.code === 'AGENT_UNAVAILABLE' ? 'Sign in to the installed agent and retry.' : 'Agent reply failed.' } : event);
        if (reply.terminal) break;
      }
      if (!reply.terminal) this.commit(reply, { type: 'error', code: 'INTERNAL', message: 'Agent ended without a result.' });
    } catch {
      if (!reply.terminal) this.commit(reply, { type: 'error', code: 'INTERNAL', message: 'Agent reply failed.' });
    } finally {
      if (this.active.get(reply.conversation.id) === reply) this.active.delete(reply.conversation.id);
      reply.finish();
    }
  }
  private commit(reply: ActiveReply, event: StreamEvent) {
    const { message, conversation } = reply;
    const stored: StoredEvent = { id: `${message.seq}:${reply.events.length}`, messageId: message.id, event };
    if (event.type === 'text') message.parts.push({ type: 'text', text: event.text });
    if (event.type === 'tool_step') message.parts.push({ type: 'tool_step', tool: event.tool, ...(event.input === undefined ? {} : { input: event.input }),
      output: { outcome: event.outcome, ...(event.output === undefined ? {} : { value: event.output }), ...(event.screenshotRef ? { screenshotRef: event.screenshotRef } : {}), ...(event.viewUrl ? { viewUrl: event.viewUrl } : {}) } });
    if (event.type === 'stopped') message.stopped = true;
    if (event.type === 'result' && event.sessionRef) conversation.sessionRef = event.sessionRef;
    conversation.updatedAt = now();
    reply.events.push(stored);
    let run: Run | undefined;
    if (terminal(event)) {
      run = { id: message.id, command: 'agent.reply', conversationId: conversation.id, startedAt: message.at, endedAt: conversation.updatedAt,
        steps: reply.events.filter(e => e.event.type === 'tool_step').length,
        turns: event.type === 'result' || event.type === 'error' ? event.turns ?? 0 : 0, outcome: event.type === 'result' ? 'ok' : 'error',
        ...((event.type === 'result' || event.type === 'error') && event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.type === 'error' ? { errorCode: event.code } : event.type === 'stopped' ? { errorCode: 'STOPPED' } : {}) };
    }
    this.store.saveChat(conversation, message, reply.events, run);
    reply.terminal = terminal(event);
    for (const listener of this.listeners.get(conversation.id) ?? []) { try { listener(stored); } catch { /* A disconnected listener cannot stop storage. */ } }
  }
  events(id: string, after?: string): StoredEvent[] {
    this.open(id);
    const events = this.store.readChatEvents(id);
    if (after === undefined) return events;
    const index = events.findIndex(e => e.id === after);
    if (index < 0) throw new CourseworkError('INVALID_INPUT', 'Unknown stream event id.');
    return events.slice(index + 1);
  }
  subscribe(id: string, after: string | undefined, listener: (event: StoredEvent) => void): () => void {
    // No await between replay and registration: the event loop cannot insert a gap.
    for (const event of this.events(id, after)) listener(event);
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  async stop(id: string, owner?: OwnerInteraction): Promise<void> {
    await this.owner(owner); this.open(id);
    const reply = this.active.get(id);
    if (!reply || reply.terminal) return;
    this.commit(reply, { type: 'stopped' });
    this.active.delete(id); reply.finish();
    // Mark stopped first so a racing/blocked iterator cannot publish another event.
    try { void Promise.resolve(reply.run?.interrupt()).catch(() => {}); } catch { /* Partial reply is already durable. */ }
  }
  async waitForIdle(id: string): Promise<void> { await this.active.get(id)?.done; }
}
