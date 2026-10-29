// Course change log `.local/lms/changes.jsonl` (openspec change local-corrections-merge, design §8, decision #296):
// after a sync saves a course file, due date and weight changes against the course's newest valid earlier document are
// appended, one JSON line per change. The diff itself is the pure `diffSnapshots` in shared/course-changes.ts, so the
// staged sync pipeline can move the append into its merge stage unchanged. Lines never contain scores.
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CourseChangeSchema, diffSnapshots } from '../../shared/course-changes.ts';
import { foreignOrigin } from './local-origin.mjs';

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
export const CHANGE_LOG_LIMIT = 200;
const logDirectory = projectDir => join(projectDir, '.local', 'lms');
const logFile = projectDir => join(logDirectory(projectDir), 'changes.jsonl');

/**
 * Appends one line `{ at, runId, courseId, assessmentId, name, field, before, after }` per change from `previous` to
 * `current` and returns the number of lines. Nothing is written when `previous` is null (first sync) or nothing changed.
 * All lines of one call are written in a single append. Throws when the log cannot be written.
 */
export async function appendCourseChanges(projectDir, { at, runId, courseId, previous, current }) {
  if (!previous) return 0;
  const changes = diffSnapshots(previous, current);
  if (!changes.length) return 0;
  const text = changes.map(change => JSON.stringify({ at, runId, courseId, ...change })).join('\n');
  await mkdir(logDirectory(projectDir), { recursive: true, mode: 0o700 });
  // A line cut short by an earlier failed write would swallow this append's first line; start on a new line.
  const separator = (await endsWithNewline(logFile(projectDir))) ? '' : '\n';
  await appendFile(logFile(projectDir), `${separator}${text}\n`, { mode: 0o600 });
  return changes.length;
}

/** Whether `path` is missing, empty or ends with a newline. */
async function endsWithNewline(path) {
  let handle;
  try { handle = await open(path, 'r'); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally { await handle.close(); }
}

/** `appendCourseChanges` for the sync runner: a failure adds 「变更记录写入失败。」 to `row.reason` and never changes its status. */
export async function recordCourseChanges(projectDir, entry, row) {
  try { await appendCourseChanges(projectDir, entry); }
  catch { row.reason = [row.reason, '变更记录写入失败。'].filter(Boolean).join(' '); }
}

/**
 * Whether the log already has a line for `courseId` written by one of `runIds` (the job IDs of a resume lineage), so
 * the merge stage of a resumed sync never appends the same course's changes twice (design §13, decision #355).
 */
export async function changeLogHasRun(projectDir, courseId, runIds) {
  if (!runIds.length) return false;
  let raw;
  try { raw = await readFile(logFile(projectDir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const runs = new Set(runIds);
  return raw.split('\n').some(line => {
    if (!line.trim()) return false;
    try { const entry = JSON.parse(line); return entry?.courseId === courseId && runs.has(entry?.runId); } catch { return false; }
  });
}

/** The newest `limit` well-formed change lines, newest first; malformed lines are skipped and a missing log is empty. */
export async function readCourseChanges(projectDir, limit = CHANGE_LOG_LIMIT) {
  let raw;
  try { raw = await readFile(logFile(projectDir), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = raw.split('\n');
  const changes = [];
  for (let index = rows.length - 1; index >= 0 && changes.length < limit; index--) {
    if (!rows[index].trim()) continue;
    try {
      const parsed = CourseChangeSchema.safeParse(JSON.parse(rows[index]));
      if (parsed.success) changes.push(parsed.data);
    } catch { /* A malformed line is skipped. */ }
  }
  return changes;
}

/** `GET /api/local/course-changes` → `{ changes }`; loopback and same-origin only. */
export function createCourseChangesHandler(projectDir) {
  return async function handleCourseChanges(req, res) {
    const remote = req.socket.remoteAddress;
    if (!remote || !LOOPBACK.includes(remote) || foreignOrigin({ origin: req.headers.origin, host: req.headers.host })) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    const [path = '/'] = (req.url ?? '/').split('?');
    if (path !== '/' && path !== '') { json(404, { error: 'NOT_FOUND' }); return; }
    if (req.method !== 'GET') { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    try { json(200, { changes: await readCourseChanges(projectDir) }); }
    catch { json(500, { error: 'CHANGES_UNAVAILABLE' }); }
  };
}
