import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { MemorySchema, type Memory } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
import { protectRead } from '../protocol/read-privacy.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { MEMORY_PAGE, memoryContracts, type MemoryCommand } from './contracts.js';

type MemoryStore = Pick<SqliteRepository, 'saveMemory' | 'loadMemory' | 'listMemories' | 'loadCourse' | 'readConversations'>;
type Input<N extends MemoryCommand> = z.output<(typeof memoryContracts)[N]['input']>;
type View = z.output<typeof import('./contracts.js').MemoryViewSchema>;
/** Fixed refusal for text the redactor cannot make safe; passed to the caller unchanged (see `safeError`). */
export const MEMORY_UNSAFE = 'The memory text contains something the privacy check cannot make safe (a credential or another person\'s identifier); rewrite it without that and record again.';
const TOO_LONG = 'The memory text is over 500 characters after redaction; shorten it and record again.';
export const memoryRefusals: readonly string[] = [MEMORY_UNSAFE, TOO_LONG];

/**
 * Redact memory text the same way for agent and owner: the agent-copy text mode masks contact details and long numbers,
 * keeps ordinary prose (such as "the student prefers"), and refuses credential-shaped values.
 */
export function redactMemoryText(text: string, privacyScope: unknown = {}): string {
  let safe: string;
  try { safe = (protectRead(text.replace(/[^\P{C}\t\n]/gu, ''), privacyScope, { agentCopy: true }) as string).trim(); }
  catch (error) {
    if (error instanceof CourseworkError && error.code === 'SOURCE_UNAVAILABLE') throw new CourseworkError('INVALID_INPUT', MEMORY_UNSAFE);
    throw error;
  }
  if (!safe) throw new CourseworkError('INVALID_INPUT', MEMORY_UNSAFE);
  if (safe.length > 500) throw new CourseworkError('INVALID_INPUT', TOO_LONG);
  return safe;
}
/** Long-term memory (C-4): agent observations and owner memories, soft-deleted, never edited by an agent. */
export class MemoryService {
  constructor(private readonly store: MemoryStore, private readonly privacyScope: unknown = {}, private readonly now = () => new Date()) {}
  private course(courseId: string | undefined) {
    if (courseId !== undefined && !this.store.loadCourse(courseId)) throw new CourseworkError('NOT_FOUND', 'Course not found.');
  }
  private live(id: string): Memory {
    const memory = this.store.loadMemory(id);
    if (!memory || memory.deletedAt) throw new CourseworkError('NOT_FOUND', 'Memory not found.');
    return memory;
  }
  private create(input: Input<'memory.record'>, origin: Memory['origin'], conversationId?: string) {
    this.course(input.courseId);
    const memory = MemorySchema.parse({ id: randomUUID(), ...(input.courseId ? { courseId: input.courseId } : {}), kind: input.kind,
      text: redactMemoryText(input.text, this.privacyScope), origin, ...(conversationId ? { conversationId } : {}), createdAt: this.now().toISOString() });
    this.store.saveMemory(memory);
    return { recorded: true as const, id: memory.id };
  }
  /** Agent observation; `conversationId` is the calling session's, supplied by the host. */
  record(input: Input<'memory.record'>, conversationId?: string) { return this.create(input, 'agent', conversationId); }
  add(input: Input<'memory.add'>) { return this.create(input, 'owner'); }
  edit(input: Input<'memory.edit'>) {
    const memory = this.live(input.id);
    this.store.saveMemory(MemorySchema.parse({ ...memory, ...(input.kind ? { kind: input.kind } : {}),
      ...(input.text !== undefined ? { text: redactMemoryText(input.text, this.privacyScope) } : {}), editedAt: this.now().toISOString() }));
    return { recorded: true as const, id: memory.id };
  }
  delete(input: Input<'memory.delete'>) {
    const memory = this.live(input.id);
    this.store.saveMemory({ ...memory, deletedAt: this.now().toISOString() });
    return { recorded: true as const, id: memory.id };
  }
  /** Live memories newest first, optionally for one course. */
  memories(courseId?: string): Memory[] {
    return this.store.listMemories().filter(memory => !memory.deletedAt && (courseId === undefined || memory.courseId === courseId));
  }
  list(input: Input<'memory.list'>): { items: View[]; nextCursor?: string } {
    const all = this.memories(input.courseId);
    let offset = 0;
    if (input.cursor) {
      const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
      if (!/^\d{1,6}$/.test(decoded) || Buffer.from(decoded).toString('base64url') !== input.cursor || Number(decoded) >= all.length) {
        throw new CourseworkError('INVALID_INPUT', 'Invalid memory continuation.');
      }
      offset = Number(decoded);
    }
    const conversations = new Set(this.store.readConversations().map(conversation => conversation.id));
    const limit = Math.min(input.limit, MEMORY_PAGE);
    const items = all.slice(offset, offset + limit).map(({ deletedAt: _deleted, conversationId, ...memory }) => ({ ...memory,
      ...(conversationId ? conversations.has(conversationId) ? { conversationId } : { sourceDeleted: true as const } : {}) }));
    const next = offset + items.length;
    return { items, ...(next < all.length ? { nextCursor: Buffer.from(String(next)).toString('base64url') } : {}) };
  }
}
