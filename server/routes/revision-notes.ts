// /api/local/revision-notes: revision notes saved from Agent replies (decision #236). GET ?courseId=, POST, DELETE /:id;
// stored in .local/revision.
import { createNote, deleteNote, listNotes } from '../../scripts/lib/revision-store.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function revisionNotesRoute({ projectDir }: RouteContext): RouteHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    const [path, query = ''] = (req.url ?? '/').split('?');
    const parts = path!.split('/').filter(Boolean);
    const allowed = parts.length === 0 ? ['GET', 'POST'] : parts.length === 1 ? ['DELETE'] : [];
    if (!allowed.length) { json(404, { error: 'NOT_FOUND' }); return; }
    if (!allowed.includes(req.method ?? '')) { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (req.method !== 'GET' && (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json')) { res.writeHead(403).end(); return; }
    const known = ['INVALID_COURSE_ID', 'INVALID_NOTE_ID', 'CONTENT_EMPTY', 'CONTENT_TOO_LONG', 'TOO_MANY_NOTES'];
    try {
      if (req.method === 'GET') { json(200, { notes: await listNotes(projectDir, new URLSearchParams(query).get('courseId') ?? '') }); return; }
      if (req.method === 'DELETE') { if (await deleteNote(projectDir, parts[0]!)) json(200, { ok: true }); else json(404, { error: 'NOTE_NOT_FOUND' }); return; }
      // Decode once after collecting the bytes: a UTF-8 character can be split across chunks.
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        chunks.push(chunk as Buffer); size += (chunk as Buffer).length;
        if (size > 100000) { json(413, { error: 'TOO_LARGE' }); return; }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown>;
      try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape'); body = parsed as Record<string, unknown>; }
      catch { json(400, { error: 'INVALID_JSON' }); return; }
      json(201, await createNote(projectDir, { courseId: body.courseId, content: body.content, chatId: body.chatId }));
    } catch (error) {
      const code = (error as Error).message;
      json(known.includes(code) ? (code === 'TOO_MANY_NOTES' ? 409 : 400) : 500, { error: known.includes(code) ? code : 'REVISION_UNAVAILABLE' });
    }
  };
}
