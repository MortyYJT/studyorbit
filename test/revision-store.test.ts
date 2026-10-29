import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNote, deleteNote, listNotes, NOTE_LIMITS } from '../scripts/lib/revision-store.mjs';

// Scenarios from specs/revision/spec.md, "Revision notes persist locally". Synthetic data only.
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'revision-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('revision store', () => {
  it('keeps notes on disk, lists one course newest first, and deletes by id', async () => {
    const first = await createNote(dir, { courseId: 'syn-1', content: '# Week 3\nRecursion notes', chatId: null });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await createNote(dir, { courseId: 'syn-1', content: 'Practice set A', chatId: null });
    await createNote(dir, { courseId: 'syn-2', content: 'Other course', chatId: null });
    expect(first.title).toBe('Week 3');
    // A fresh read from the same folder stands in for a server restart.
    expect((await listNotes(dir, 'syn-1')).map(note => note.id)).toEqual([second.id, first.id]);
    expect((await stat(join(dir, '.local', 'revision', 'notes.json'))).mode & 0o777).toBe(0o600);
    expect(await deleteNote(dir, first.id)).toBe(true);
    expect(await deleteNote(dir, first.id)).toBe(false);
    expect((await listNotes(dir, 'syn-1')).map(note => note.id)).toEqual([second.id]);
  });

  it('rejects an unsafe course id and writes nothing', async () => {
    await expect(createNote(dir, { courseId: '../x', content: 'x', chatId: null })).rejects.toThrow('INVALID_COURSE_ID');
    await expect(listNotes(dir, '../x')).rejects.toThrow('INVALID_COURSE_ID');
    await expect(stat(join(dir, '.local', 'revision'))).rejects.toThrow();
  });

  it('rejects empty or oversized text and enforces the per-course cap', async () => {
    await expect(createNote(dir, { courseId: 'syn-1', content: '  ', chatId: null })).rejects.toThrow('CONTENT_EMPTY');
    await expect(createNote(dir, { courseId: 'syn-1', content: 'x'.repeat(NOTE_LIMITS.content + 1), chatId: null })).rejects.toThrow('CONTENT_TOO_LONG');
    await Promise.all(Array.from({ length: NOTE_LIMITS.perCourse }, (_, index) => createNote(dir, { courseId: 'syn-1', content: `note ${index}`, chatId: null })));
    expect(await listNotes(dir, 'syn-1')).toHaveLength(NOTE_LIMITS.perCourse);
    await expect(createNote(dir, { courseId: 'syn-1', content: 'one more', chatId: null })).rejects.toThrow('TOO_MANY_NOTES');
  });
});

describe('revision store when the file is damaged', () => {
  it('refuses to write over a file it cannot parse, and keeps entries it does not recognise', async () => {
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const file = join(dir, '.local', 'revision', 'notes.json');
    await mkdir(join(dir, '.local', 'revision'), { recursive: true });
    await writeFile(file, '{ not json');
    await expect(createNote(dir, { courseId: 'syn-1', content: 'new', chatId: null })).rejects.toThrow('REVISION_UNREADABLE');
    expect(await readFile(file, 'utf8')).toBe('{ not json');
    await writeFile(file, JSON.stringify([{ id: 'future-shape', courseId: 'syn-2', body: 'kept' }]));
    await createNote(dir, { courseId: 'syn-1', content: 'new', chatId: null });
    expect(JSON.parse(await readFile(file, 'utf8'))[0]).toEqual({ id: 'future-shape', courseId: 'syn-2', body: 'kept' });
  });
});
