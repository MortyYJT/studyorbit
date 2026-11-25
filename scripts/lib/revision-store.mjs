// Local store of the revision notes that the former built-in chat saved (decision #236): one JSON file in the ignored
// `.local/revision/`. Notes can be listed and deleted; nothing creates them any more (decision #553). Course ids are
// checked against a strict pattern and note ids are UUIDs; writes are serialised.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const CONTENT_LIMIT = 20000;
const COURSE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NoteSchema = z.object({
  id: z.string().regex(UUID), courseId: z.string().regex(COURSE_ID), title: z.string().max(200),
  content: z.string().max(CONTENT_LIMIT), chatId: z.string().regex(UUID).nullable(), savedAt: z.string(),
});

function isCourseId(value) { return typeof value === 'string' && COURSE_ID.test(value); }
const notesFile = projectDir => join(projectDir, '.local', 'revision', 'notes.json');

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

// Read-modify-write on one file: queue updates so concurrent deletes cannot drop each other.
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
