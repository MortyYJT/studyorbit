// /api/local/course-sync: GET status, POST { ids } start, DELETE cancel. The runner is scripts/course-sync-runner.mjs
// until the staged pipeline replaces it (local-server-sync-pipeline PR 3). When the sync store could not be opened,
// every method answers `503 SYNC_STORE_UNAVAILABLE` and the other routes keep working (decision #344).
import type { createCourseSyncRunner } from '../../scripts/course-sync-runner.mjs';
import type { RouteHandler } from '../context.ts';

export type CourseRunner = ReturnType<typeof createCourseSyncRunner>;

export function courseSyncRoute(courseRunner: CourseRunner, storeAvailable: boolean): RouteHandler {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!storeAvailable) { res.writeHead(503).end(JSON.stringify({ error: 'SYNC_STORE_UNAVAILABLE' })); return; }
    if (req.method === 'GET') { res.end(JSON.stringify(courseRunner.status())); return; }
    if (req.method !== 'POST' && req.method !== 'DELETE') { res.writeHead(405).end(); return; }
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
    if (req.method === 'DELETE') { res.end(JSON.stringify(courseRunner.cancel())); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 10000) throw new Error('INVALID_SELECTION');
      }
      const data = JSON.parse(body);
      if (!data || Object.keys(data).length !== 1 || !Array.isArray(data.ids)) throw new Error('INVALID_SELECTION');
      const state = await courseRunner.start(data.ids);
      res.writeHead(202).end(JSON.stringify(state));
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'INVALID_SELECTION';
      res.writeHead(reason === 'SYNC_RUNNING' ? 409 : 400).end(JSON.stringify({ error: reason }));
    }
  };
}
