import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { MemorySchema, type Memory } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { MEMORY_PAGE, memoryContracts, type MemoryCommand } from './contracts.js';

type MemoryStore = Pick<SqliteRepository, 'saveMemory' | 'loadMemory' | 'listMemories' | 'loadCourse' | 'readConversations'>;
type Input<N extends MemoryCommand> = z.output<(typeof memoryContracts)[N]['input']>;
type View = z.output<typeof import('./contracts.js').MemoryViewSchema>;
const TOO_LONG = 'The memory text is over 500 characters; shorten it and record again.';
const EMPTY = 'The memory text must not be empty.';
export const memoryRefusals: readonly string[] = [EMPTY, TOO_LONG];

/** Normalize copied text and strip control characters; personal details are retained (#191). */
export function normalizeMemoryText(text: string): string {
  const plain = text.normalize('NFKC').replace(/[^\P{C}\t\n]/gu, '').trim();
  if (!plain) throw new CourseworkError('INVALID_INPUT', EMPTY);
  if (plain.length > 500) throw new CourseworkError('INVALID_INPUT', TOO_LONG);
  return plain;
}
/** Long-term memory (C-4): agent observations and owner memories, soft-deleted, never edited by an agent. */
export class MemoryService {
  constructor(private readonly store: MemoryStore, private readonly now = () => new Date()) {}
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
      text: normalizeMemoryText(input.text), origin, ...(conversationId ? { conversationId } : {}), createdAt: this.now().toISOString() });
    this.store.saveMemory(memory);
    return { recorded: true as const, id: memory.id };
  }
  /** Agent observation; `conversationId` is the calling session's, supplied by the host. */
  record(input: Input<'memory.record'>, conversationId?: string) { return this.create(input, 'agent', conversationId); }
  add(input: Input<'memory.add'>) { return this.create(input, 'owner'); }
  edit(input: Input<'memory.edit'>) {
    const memory = this.live(input.id);
    this.store.saveMemory(MemorySchema.parse({ ...memory, ...(input.kind ? { kind: input.kind } : {}),
      ...(input.text !== undefined ? { text: normalizeMemoryText(input.text) } : {}), editedAt: this.now().toISOString() }));
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
