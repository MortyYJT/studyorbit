// Local store for revision notes saved from Agent replies (decision #236): one JSON file in the ignored `.local/revision/`.
// Course ids are checked against a strict pattern and note ids are server-generated UUIDs; writes are serialised.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const NOTE_LIMITS = { content: 20000, perCourse: 200 };
const COURSE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_LIMIT = 60;

const NoteSchema = z.object({
  id: z.string().regex(UUID), courseId: z.string().regex(COURSE_ID), title: z.string().max(200),
  content: z.string().max(NOTE_LIMITS.content), chatId: z.string().regex(UUID).nullable(), savedAt: z.string(),
});

function isCourseId(value) { return typeof value === 'string' && COURSE_ID.test(value); }
const notesFile = projectDir => join(projectDir, '.local', 'revision', 'notes.json');

/** First non-empty line without Markdown heading or bullet marks, cut to 60 characters. */
function titleOf(content) {
  const line = content.split('\n').map(text => text.replace(/^\s*(#{1,6}|[-*•]|\d+[.)、])\s+/, '').replace(/\*\*/g, '').trim()).find(Boolean) ?? '';
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

/**
 * Every stored entry as written, including ones this version does not recognise. Only a missing file reads as empty:
 * any other read or parse failure throws, so a later write can never replace notes it could not read.
 */
async function readRaw(projectDir) {
  let text;
  try { text = await readFile(notesFile(projectDir), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('REVISION_UNREADABLE');
  }
  try { const value = JSON.parse(text); if (Array.isArray(value)) return value; } catch { /* Reported below. */ }
  throw new Error('REVISION_UNREADABLE');
}
const valid = entries => entries.flatMap(item => { const parsed = NoteSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });

async function writeAll(projectDir, notes) {
  const file = notesFile(projectDir);
  await mkdir(join(projectDir, '.local', 'revision'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(notes, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) { await rm(temp, { force: true }); throw error; }
}

// Read-modify-write on one file: queue updates so concurrent saves cannot drop each other.
let queue = Promise.resolve();
function update(change) {
  const run = queue.then(change);
  queue = run.catch(() => undefined);
  return run;
}

export async function listNotes(projectDir, courseId) {
  if (!isCourseId(courseId)) throw new Error('INVALID_COURSE_ID');
  return valid(await readRaw(projectDir)).filter(note => note.courseId === courseId).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function createNote(projectDir, { courseId, content, chatId }) {
  if (!isCourseId(courseId)) return Promise.reject(new Error('INVALID_COURSE_ID'));
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) return Promise.reject(new Error('CONTENT_EMPTY'));
  if (text.length > NOTE_LIMITS.content) return Promise.reject(new Error('CONTENT_TOO_LONG'));
  return update(async () => {
    const notes = await readRaw(projectDir);
    if (valid(notes).filter(note => note.courseId === courseId).length >= NOTE_LIMITS.perCourse) throw new Error('TOO_MANY_NOTES');
    const note = { id: randomUUID(), courseId, title: titleOf(text), content: text, chatId: typeof chatId === 'string' && UUID.test(chatId) ? chatId : null, savedAt: new Date().toISOString() };
    await writeAll(projectDir, [...notes, note]);
    return note;
  });
}

export function deleteNote(projectDir, id) {
  if (typeof id !== 'string' || !UUID.test(id)) return Promise.reject(new Error('INVALID_NOTE_ID'));
  return update(async () => {
    const notes = await readRaw(projectDir);
    const rest = notes.filter(note => !(note && typeof note === 'object' && note.id === id));
    if (rest.length === notes.length) return false;
    await writeAll(projectDir, rest);
    return true;
  });
}
