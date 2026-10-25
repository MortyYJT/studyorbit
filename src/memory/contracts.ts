import { z } from 'zod';
import { MemoryKindSchema } from '../domain/schemas.js';
import { CursorSchema, IdSchema } from '../protocol/contracts.js';

const time = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(500);
const receipt = z.strictObject({ recorded: z.literal(true), id: IdSchema });
/** Large enough for the newest page of memories, small enough that 30 memories of 500 CJK characters fit in 64 KiB. */
export const MEMORY_PAGE = 30;
/**
 * A live memory as reads return it. `conversationId` is present only while the source conversation still exists;
 * `sourceDeleted` marks a memory whose source conversation was deleted.
 */
export const MemoryViewSchema = z.strictObject({ id: IdSchema, courseId: IdSchema.optional(), kind: MemoryKindSchema, text: z.string().min(1).max(4000),
  origin: z.enum(['agent', 'owner']), createdAt: time, editedAt: time.optional(), conversationId: IdSchema.optional(), sourceDeleted: z.literal(true).optional() });
export const memoryContracts = {
  // The source conversation comes from the calling session (tool scope or the MCP server's environment), never from input.
  'memory.record': { input: z.strictObject({ courseId: IdSchema.optional(), kind: MemoryKindSchema, text }), output: receipt, level: 0 as const },
  'memory.list': { input: z.strictObject({ courseId: IdSchema.optional(), cursor: CursorSchema.optional(), limit: z.number().int().min(1).max(MEMORY_PAGE).default(MEMORY_PAGE) }),
    output: z.strictObject({ items: z.array(MemoryViewSchema).max(MEMORY_PAGE), nextCursor: CursorSchema.optional() }), level: 0 as const },
  'memory.add': { input: z.strictObject({ courseId: IdSchema.optional(), kind: MemoryKindSchema, text }), output: receipt, level: 0 as const },
  'memory.edit': { input: z.strictObject({ id: IdSchema, kind: MemoryKindSchema.optional(), text: text.optional() }).refine(value => value.kind !== undefined || value.text !== undefined),
    output: receipt, level: 0 as const },
  'memory.delete': { input: z.strictObject({ id: IdSchema }), output: receipt, level: 0 as const },
};
export type MemoryCommand = keyof typeof memoryContracts;
/** Owner commands (frontend session or TTY); agents are refused (#178, #188). */
export const memoryOwnerCommands: ReadonlySet<string> = new Set(['memory.add', 'memory.edit', 'memory.delete']);
