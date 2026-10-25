import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MemorySchema } from '../../src/domain/schemas.js';
import { SqliteRepository } from '../../src/store/sqlite.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const memory = { id: 'mem-1', courseId: 'c-1', kind: 'weakness' as const, text: 'Mixes up eigenvalues and eigenvectors',
  origin: 'agent' as const, conversationId: 'v-1', createdAt: '2026-10-24T01:00:00.000Z' };

it('migration 005 adds memories; rows survive reopening and existing tables are untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coursework-005-')); dirs.push(dir);
  const file = join(dir, 'db.sqlite');
  const first = new SqliteRepository(file);
  first.saveModule({ id: 'm', name: 'Synthetic', glyph: 'S', auto: false });
  first.saveMemory(memory);
  first.close();
  // PRAGMA user_version is a big-endian 32-bit integer at SQLite header offset 60.
  expect(readFileSync(file).readUInt32BE(60)).toBe(5);
  const second = new SqliteRepository(file);
  try {
    expect(second.loadModule('m')).toMatchObject({ id: 'm' });
    expect(second.loadMemory('mem-1')).toEqual(memory);
  } finally { second.close(); }
});

it('lists every memory newest first, deleted ones included, and replaces a row on save', () => {
  const store = new SqliteRepository(':memory:');
  try {
    const older = { ...memory, id: 'mem-0', createdAt: '2026-10-20T01:00:00.000Z' };
    store.saveMemory(older); store.saveMemory(memory);
    store.saveMemory({ ...older, deletedAt: '2026-10-25T00:00:00.000Z' });
    expect(store.listMemories().map(row => [row.id, row.deletedAt])).toEqual([['mem-1', undefined], ['mem-0', '2026-10-25T00:00:00.000Z']]);
    expect(store.loadMemory('missing')).toBeUndefined();
  } finally { store.close(); }
});

it('Memory schema: kinds, 500-character text, origin and optional course, source, edit and delete times', () => {
  expect(MemorySchema.parse(memory)).toEqual(memory);
  expect(MemorySchema.parse({ id: 'g', kind: 'preference', text: 'Explain with an example first', origin: 'owner', createdAt: memory.createdAt }))
    .not.toHaveProperty('conversationId');
  expect(MemorySchema.safeParse({ ...memory, kind: 'mood' }).success).toBe(false);
  expect(MemorySchema.safeParse({ ...memory, text: 'x'.repeat(501) }).success).toBe(false);
  expect(MemorySchema.safeParse({ ...memory, text: '' }).success).toBe(false);
  expect(MemorySchema.safeParse({ ...memory, origin: 'sync' }).success).toBe(false);
  expect(MemorySchema.safeParse({ ...memory, editedAt: 'yesterday' }).success).toBe(false);
});
