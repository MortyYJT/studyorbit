// The owner's corrections store (openspec/changes/local-corrections-merge, decisions #290-#298): one file per course in
// the ignored `.local/corrections/<courseId>.json` (0600 in a 0700 directory), written atomically, read-modify-write
// serialised per file, and never overwritten when it cannot be read. Also the HTTP handler for `/api/local/corrections`,
// kept here so the server that mounts it (Vite today, the standalone local server later) only wires it in.
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CORRECTION_LIMITS, StoreSchema, applyOwnerEdit, assessmentFields, dropImportNoise, emptyView, isCourseId, normaliseCorrections,
  parseCorrectionsInput, pruneConflicts, transitionConflicts, viewOf,
} from '../../shared/corrections.ts';
import { migrateLocalKeys } from '../../shared/local-keys.ts';
import { foreignOrigin } from './local-origin.mjs';

/** A store error carrying an API error code; `current` is the current view for `REVISION_MISMATCH`. */
export class CorrectionsError extends Error {
  constructor(code, current) { super(code); this.code = code; if (current) this.current = current; }
}

const directory = projectDir => join(projectDir, '.local', 'corrections');
const STORE_FILE = /^(\d{1,20})\.json$/;

// One queue per file: concurrent read-modify-write on the same course runs in call order; other courses do not wait.
const queues = new Map();
function enqueue(file, task) {
  const run = (queues.get(file) ?? Promise.resolve()).then(task);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(file, settled);
  void settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return run;
}

/** The stored file, or null when it does not exist. Any other failure is `CORRECTIONS_UNREADABLE`, so nothing replaces it. */
async function readStoreFile(file, courseId) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new CorrectionsError('CORRECTIONS_UNREADABLE');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new CorrectionsError('CORRECTIONS_UNREADABLE'); }
  const parsed = StoreSchema.safeParse(value);
  if (!parsed.success || parsed.data.courseId !== courseId) throw new CorrectionsError('CORRECTIONS_UNREADABLE');
  return parsed.data;
}

async function writeTemp(projectDir, file, store) {
  await mkdir(directory(projectDir), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) { await rm(temp, { force: true }); throw error; }
  return temp;
}

/** Atomically replaces the file (temp file + rename). */
async function replaceFile(projectDir, file, store) {
  const temp = await writeTemp(projectDir, file, store);
  try { await rename(temp, file); } catch (error) { await rm(temp, { force: true }); throw error; }
}

/** Atomically creates the file only when none exists (temp file + hard link, which fails on an existing name). */
async function createFile(projectDir, file, store) {
  const temp = await writeTemp(projectDir, file, store);
  try { await link(temp, file); return true; }
  catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
  finally { await rm(temp, { force: true }); }
}

/**
 * @param {{ projectDir: string, loadDocument: (courseId: string) => Promise<import('../../shared/course-data.ts').CourseDocument | null>, now?: () => Date }} options
 * `loadDocument` returns the newest valid course file of a course (null when there is none); it is read when a store is
 * created, to become the merge base.
 */
export function createCorrectionsStore({ projectDir, loadDocument, now = () => new Date() }) {
  const fileOf = courseId => join(directory(projectDir), `${courseId}.json`);
  const checkCourse = courseId => { if (!isCourseId(courseId)) throw new CorrectionsError('INVALID_COURSE_ID'); };
  const parse = (courseId, body, options) => {
    const parsed = parseCorrectionsInput(courseId, body, options);
    if (!parsed.ok) throw new CorrectionsError(parsed.error);
    return parsed.value;
  };

  // A new store: the course's newest valid file is the base (digest null without one); keys move through its legacyIds,
  // fields equal to the base are dropped, and corrections pointing at assessments absent from the base are flagged.
  async function newStore(courseId, input, { importing }) {
    let document;
    try { document = await loadDocument(courseId); } catch { throw new CorrectionsError('CORRECTIONS_UNAVAILABLE'); }
    const base = document
      ? { digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'), assessments: assessmentFields(document, courseId) }
      : { digest: null, assessments: {} };
    const legacyIds = document?.version === 2 ? document.legacyIds : {};
    const moved = migrateLocalKeys({ corrections: input.corrections, manual: { [courseId]: input.manual }, order: { [courseId]: input.order }, work: [] }, courseId, legacyIds).stores;
    const corrections = importing ? dropImportNoise(moved.corrections, courseId) : moved.corrections;
    const kept = normaliseCorrections({ courseId, base, corrections, pins: {} });
    const at = now().toISOString();
    const store = {
      version: 1, courseId, revision: 1, base, corrections: kept.corrections, manual: moved.manual[courseId] ?? [], order: moved.order[courseId] ?? [],
      pins: kept.pins, conflicts: transitionConflicts(kept.corrections, base, courseId, at), updatedAt: at,
    };
    // Never write a file this module could not read back.
    if (!StoreSchema.safeParse(store).success) throw new CorrectionsError('INVALID_BODY');
    return store;
  }

  return {
    /** Every course with a store file; an unreadable file is reported for that course only. */
    async list() {
      let names;
      try { names = await readdir(directory(projectDir)); } catch (error) {
        if (error?.code === 'ENOENT') return { courses: {} };
        throw new CorrectionsError('CORRECTIONS_UNAVAILABLE');
      }
      const courses = {};
      for (const name of names.sort()) {
        const courseId = STORE_FILE.exec(name)?.[1];
        if (!courseId) continue;
        try { const store = await readStoreFile(fileOf(courseId), courseId); if (store) courses[courseId] = viewOf(store); }
        catch { courses[courseId] = { error: 'CORRECTIONS_UNREADABLE' }; }
      }
      return { courses };
    },

    /** One course; a missing file reads as an empty view with revision 0. */
    async read(courseId) {
      checkCourse(courseId);
      const store = await readStoreFile(fileOf(courseId), courseId);
      return store ? viewOf(store) : emptyView();
    },

    /**
     * Saves `{ revision, corrections, manual, order }`. `revision` must equal the stored one (0 when there is no file,
     * which creates the store); otherwise `REVISION_MISMATCH` with the current view. Returns the new view.
     */
    save(courseId, body) {
      try { checkCourse(courseId); body = parse(courseId, body, { revision: true }); } catch (error) { return Promise.reject(error); }
      const file = fileOf(courseId);
      return enqueue(file, async () => {
        const current = await readStoreFile(file, courseId);
        if (body.revision !== (current?.revision ?? 0)) throw new CorrectionsError('REVISION_MISMATCH', current ? viewOf(current) : emptyView());
        if (!current) {
          const store = await newStore(courseId, body, { importing: false });
          if (await createFile(projectDir, file, store)) return viewOf(store);
          const existing = await readStoreFile(file, courseId);
          throw new CorrectionsError('REVISION_MISMATCH', existing ? viewOf(existing) : emptyView());
        }
        const edit = applyOwnerEdit(current, body.corrections);
        const kept = normaliseCorrections({ courseId, base: current.base, corrections: edit.corrections, pins: edit.pins });
        const next = {
          ...current, revision: current.revision + 1, corrections: kept.corrections, manual: body.manual, order: body.order,
          pins: kept.pins, conflicts: pruneConflicts(edit.conflicts, kept.corrections), updatedAt: now().toISOString(),
        };
        if (!StoreSchema.safeParse(next).success) throw new CorrectionsError('INVALID_BODY');
        await replaceFile(projectDir, file, next);
        return viewOf(next);
      });
    },

    /**
     * One-time import from browser storage: creates the store only when no file exists (`{ imported: true, store }`),
     * otherwise `{ imported: false }` and nothing changes. An unreadable file is never replaced.
     */
    importCourse(courseId, body) {
      try { checkCourse(courseId); body = parse(courseId, body); } catch (error) { return Promise.reject(error); }
      const file = fileOf(courseId);
      return enqueue(file, async () => {
        if (await readStoreFile(file, courseId)) return { imported: false };
        const store = await newStore(courseId, body, { importing: true });
        return await createFile(projectDir, file, store) ? { imported: true, store: viewOf(store) } : { imported: false };
      });
    },
  };
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const STATUS = { INVALID_COURSE_ID: 400, INVALID_BODY: 400, TOO_LARGE: 413, REVISION_MISMATCH: 409, CONFLICT_NOT_FOUND: 404, CORRECTIONS_UNREADABLE: 500 };

/**
 * Node request handler for `/api/local/corrections`, with `req.url` relative to that mount point:
 * `GET /` (all, or one with `?courseId=`), `PUT /<courseId>`, `POST /<courseId>/import`.
 * Loopback and same-origin only; writes need an exact `Origin` and `Content-Type: application/json`; bodies up to 1 MB.
 */
export function createCorrectionsHandler(store) {
  return async function handleCorrections(req, res) {
    const remote = req.socket.remoteAddress;
    if (!remote || !LOOPBACK.includes(remote) || foreignOrigin({ origin: req.headers.origin, host: req.headers.host })) { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    const [path = '/', query = ''] = (req.url ?? '/').split('?');
    const parts = path.split('/').filter(Boolean);
    const route = parts.length === 0 ? 'list' : parts.length === 1 ? 'save' : parts.length === 2 && parts[1] === 'import' ? 'import' : null;
    if (!route) { json(404, { error: 'NOT_FOUND' }); return; }
    if (req.method !== { list: 'GET', save: 'PUT', import: 'POST' }[route]) { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.method !== 'GET' && (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json')) { res.writeHead(403).end(); return; }
    try {
      if (route === 'list') {
        const courseId = new URLSearchParams(query).get('courseId');
        json(200, courseId === null ? await store.list() : await store.read(courseId));
        return;
      }
      const courseId = parts[0];
      if (!isCourseId(courseId)) { json(400, { error: 'INVALID_COURSE_ID' }); return; }
      // Decode once after collecting the bytes (a UTF-8 character can be split across chunks); drain an oversized body.
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size <= CORRECTION_LIMITS.bodyBytes) chunks.push(chunk); }
      if (size > CORRECTION_LIMITS.bodyBytes) { json(413, { error: 'TOO_LARGE' }); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(400, { error: 'INVALID_BODY' }); return; }
      if (route === 'save') { json(200, await store.save(courseId, body)); return; }
      const result = await store.importCourse(courseId, body);
      json(result.imported ? 201 : 200, result);
    } catch (error) {
      const code = error instanceof CorrectionsError && error.code in STATUS ? error.code : 'CORRECTIONS_UNAVAILABLE';
      json(STATUS[code] ?? 500, code === 'REVISION_MISMATCH' ? { error: code, current: error.current } : { error: code });
    }
  };
}
