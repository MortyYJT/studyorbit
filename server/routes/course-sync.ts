// /api/local/course-sync: GET status, POST { ids } start, DELETE cancel (design §12). The staged pipeline
// (scripts/lib/sync-pipeline.mjs) runs the sync; the status is built from the newest job in the sync store, so it
// survives a restart. When the store could not be opened there is no pipeline and every method answers
// `503 SYNC_STORE_UNAVAILABLE`; the other routes keep working (decision #344).
import type { SyncPipeline } from '../../scripts/lib/sync-pipeline.mjs';
import type { RouteHandler } from '../context.ts';

export function courseSyncRoute(pipeline: SyncPipeline | null): RouteHandler {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!pipeline) { res.writeHead(503).end(JSON.stringify({ error: 'SYNC_STORE_UNAVAILABLE' })); return; }
    if (req.method === 'GET') { res.end(JSON.stringify(pipeline.status())); return; }
    if (req.method !== 'POST' && req.method !== 'DELETE') { res.writeHead(405).end(); return; }
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
    if (req.method === 'DELETE') { res.end(JSON.stringify(pipeline.cancel())); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 10000) throw new Error('INVALID_SELECTION');
      }
      const data = JSON.parse(body);
      if (!data || Object.keys(data).length !== 1 || !Array.isArray(data.ids)) throw new Error('INVALID_SELECTION');
      const state = await pipeline.start(data.ids);
      res.writeHead(202).end(JSON.stringify(state));
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'INVALID_SELECTION';
      res.writeHead(reason === 'SYNC_RUNNING' ? 409 : 400).end(JSON.stringify({ error: reason }));
    }
  };
}
