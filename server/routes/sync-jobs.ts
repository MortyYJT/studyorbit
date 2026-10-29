// /api/local/sync-jobs (design §12): GET the newest 20 sync jobs; POST /<jobId>/resume (JSON body `{}`, same write
// checks as the other routes) starts a new job that continues the stopped one from its checkpoints.
import type { SyncPipeline } from '../../scripts/lib/sync-pipeline.mjs';
import type { RouteHandler } from '../context.ts';

const CONFLICTS = new Set(['SYNC_RUNNING', 'NOT_RESUMABLE', 'ALREADY_RESUMED', 'RESUME_EXPIRED']);

export function syncJobsRoute(pipeline: SyncPipeline | null): RouteHandler {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => { res.writeHead(status).end(JSON.stringify(value)); };
    if (!pipeline) { json(503, { error: 'SYNC_STORE_UNAVAILABLE' }); return; }
    const [path = '/'] = (req.url ?? '/').split('?');
    if (path === '/' || path === '') {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      json(200, { jobs: pipeline.jobs() });
      return;
    }
    const match = /^\/([A-Za-z0-9-]{1,64})\/resume$/.exec(path);
    if (!match) { json(404, { error: 'NOT_FOUND' }); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
    let data: unknown;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 10000) throw new Error('INVALID_REQUEST');
      }
      data = JSON.parse(body);
    } catch { json(400, { error: 'INVALID_REQUEST' }); return; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) { json(400, { error: 'INVALID_REQUEST' }); return; }
    try {
      json(202, await pipeline.resume(match[1]!));
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'INVALID_REQUEST';
      json(reason === 'JOB_NOT_FOUND' ? 404 : CONFLICTS.has(reason) ? 409 : 400, { error: reason });
    }
  };
}
