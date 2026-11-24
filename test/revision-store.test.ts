import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteNote, listNotes } from '../scripts/lib/revision-store.mjs';

// Scenarios from specs/revision/spec.md, "Revision notes persist locally". Notes were written by the former built-in
// chat; the store now only lists and deletes them, so the tests write the file as that chat left it. Synthetic data.
let dir: string;
const file = () => join(dir, '.local', 'revision', 'notes.json');
const note = (id: string, courseId: string, savedAt: string) => ({ id: `0b0e7c1e-3d5a-4f6b-8a9c-00000000000${id}`, courseId, title: `Note ${id}`, content: `Synthetic note ${id}`, chatId: null, savedAt });
const seed = async (entries: unknown[]) => { await mkdir(join(dir, '.local', 'revision'), { recursive: true }); await writeFile(file(), JSON.stringify(entries)); };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'revision-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('revision store', () => {
  it('lists one course newest first and deletes by id', async () => {
    const first = note('1', 'syn-1', '2026-10-01T00:00:00.000Z'), second = note('2', 'syn-1', '2026-10-02T00:00:00.000Z'), other = note('3', 'syn-2', '2026-10-03T00:00:00.000Z');
    await seed([first, second, other]);
    expect((await listNotes(dir, 'syn-1')).map(entry => entry.id)).toEqual([second.id, first.id]);
    expect(await deleteNote(dir, first.id)).toBe(true);
    expect(await deleteNote(dir, first.id)).toBe(false);
    expect((await listNotes(dir, 'syn-1')).map(entry => entry.id)).toEqual([second.id]);
    expect((await listNotes(dir, 'syn-2')).map(entry => entry.id)).toEqual([other.id]);
  });

  it('reads a missing file as no notes and rejects unsafe ids without writing', async () => {
    expect(await listNotes(dir, 'syn-1')).toEqual([]);
    await expect(listNotes(dir, '../x')).rejects.toThrow('INVALID_COURSE_ID');
    await expect(deleteNote(dir, '../x')).rejects.toThrow('INVALID_NOTE_ID');
    await expect(readFile(file(), 'utf8')).rejects.toThrow();
  });
});

describe('revision store when the file is damaged', () => {
  it('refuses to write over a file it cannot parse, and keeps entries it does not recognise', async () => {
    const kept = note('1', 'syn-1', '2026-10-01T00:00:00.000Z');
    await mkdir(join(dir, '.local', 'revision'), { recursive: true });
    await writeFile(file(), '{ not json');
    await expect(listNotes(dir, 'syn-1')).rejects.toThrow('REVISION_UNREADABLE');
    await expect(deleteNote(dir, kept.id)).rejects.toThrow('REVISION_UNREADABLE');
    expect(await readFile(file(), 'utf8')).toBe('{ not json');
    await seed([{ id: 'future-shape', courseId: 'syn-2', body: 'kept' }, kept]);
    expect(await deleteNote(dir, kept.id)).toBe(true);
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual([{ id: 'future-shape', courseId: 'syn-2', body: 'kept' }]);
  });
});
