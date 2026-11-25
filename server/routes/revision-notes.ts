// /api/local/revision-notes: notes saved from replies of the former built-in chat (decision #236), kept in
// .local/revision. GET ?courseId= lists them and DELETE /:id removes one. Nothing creates notes any more: replies are
// rendered by DeepTutor, which has its own notebook (decision #553).
import { deleteNote, listNotes } from '../../scripts/lib/revision-store.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function revisionNotesRoute({ projectDir }: RouteContext): RouteHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    const [path, query = ''] = (req.url ?? '/').split('?');
    const parts = path!.split('/').filter(Boolean);
    const allowed = parts.length === 0 ? ['GET'] : parts.length === 1 ? ['DELETE'] : [];
    if (!allowed.length) { json(404, { error: 'NOT_FOUND' }); return; }
    if (!allowed.includes(req.method ?? '')) { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.method !== 'GET' && (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json')) { res.writeHead(403).end(); return; }
    const known = ['INVALID_COURSE_ID', 'INVALID_NOTE_ID'];
    try {
      if (req.method === 'GET') { json(200, { notes: await listNotes(projectDir, new URLSearchParams(query).get('courseId') ?? '') }); return; }
      if (await deleteNote(projectDir, parts[0]!)) json(200, { ok: true }); else json(404, { error: 'NOTE_NOT_FOUND' });
    } catch (error) {
      const code = (error as Error).message;
      json(known.includes(code) ? 400 : 500, { error: known.includes(code) ? code : 'REVISION_UNAVAILABLE' });
    }
  };
}
