// The local API as a plain Node request handler (design §2): the access guard (§3) in front of the route table. Each
// route keeps the path, methods, status codes, bodies, error codes and body limits it had in `vite.config.ts`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCourseSyncRunner } from '../scripts/course-sync-runner.mjs';
import type { OpenResult } from '../scripts/lib/sync-store.mjs';
import type { Env, RouteContext, RouteHandler } from './context.ts';
import { checkRequest } from './guard.ts';
import { chatsRoute } from './routes/chats.ts';
import { correctionsRoute } from './routes/corrections.ts';
import { courseCandidatesRoute } from './routes/course-candidates.ts';
import { courseChangesRoute } from './routes/course-changes.ts';
import { courseReportsRoute } from './routes/course-reports.ts';
import { courseSyncRoute, type CourseRunner } from './routes/course-sync.ts';
import { llmConfigRoute } from './routes/llm-config.ts';
import { revisionNotesRoute } from './routes/revision-notes.ts';
import { syncCoursesRoute } from './routes/sync-courses.ts';
import { syncUsageRoute } from './routes/sync-usage.ts';

export const API_PREFIX = '/api/local';
const DISCOVERY_SCRIPT = fileURLToPath(new URL('../scripts/canvas-background.mjs', import.meta.url));

export type LocalApiOptions = {
  projectDir: string;
  /** Defaults to `~/Desktop`. */
  desktopDir?: string;
  /** Per-launch token every request must carry in `x-studyorbit-token`. */
  token: string;
  /** Port of the page (Vite); the only port accepted in `Host`. */
  webPort: number;
  /** Result of `openSyncStore`; an unavailable store makes the sync routes answer 503. Absent: no store yet. */
  store?: OpenResult;
  /** Defaults to `process.env`. */
  env?: Env;
  /** Test seams: a fake sync runner and a stub discovery script. Real ones by default. */
  courseRunner?: CourseRunner;
  discoveryScript?: string;
};

export type LocalApi = {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Stops a running course sync (as a cancel) and course discovery; later requests get 503 (shutting down). */
  close(): void;
  /** True while a course sync is running. */
  syncRunning(): boolean;
};

export function createLocalApi(options: LocalApiOptions): LocalApi {
  const context: RouteContext = {
    projectDir: options.projectDir,
    desktopDir: options.desktopDir ?? join(homedir(), 'Desktop'),
    env: options.env ?? process.env,
  };
  const courseRunner = options.courseRunner ?? createCourseSyncRunner(options.projectDir);
  const discovery = syncCoursesRoute(context, options.discoveryScript ?? DISCOVERY_SCRIPT);
  const routes: [string, RouteHandler][] = [
    ['sync-usage', syncUsageRoute(context)],
    ['llm-config', llmConfigRoute(context)],
    ['course-reports', courseReportsRoute(context)],
    ['corrections', correctionsRoute(context)],
    ['course-changes', courseChangesRoute(context)],
    ['revision-notes', revisionNotesRoute(context)],
    ['chats', chatsRoute(context)],
    ['course-sync', courseSyncRoute(courseRunner, options.store?.ok !== false)],
    ['sync-courses', discovery.route],
    ['course-candidates', courseCandidatesRoute(context)],
  ];
  const mounts = routes.map(([name, handler]) => [`${API_PREFIX}/${name}`, handler] as const);

  let closed = false;
  function handle(req: IncomingMessage, res: ServerResponse) {
    if (checkRequest(req, options)) { res.writeHead(403).end(); return; }
    if (closed) { res.writeHead(503).end(); return; }
    const url = req.url ?? '/';
    const pathEnd = url.search(/[?#]/);
    const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
    // Prefix match on a path-segment boundary, as connect's `use(path, handler)` did under Vite.
    const mount = mounts.find(([prefix]) => path.startsWith(prefix) && (path.length === prefix.length || path[prefix.length] === '/' || path[prefix.length] === '.'));
    if (!mount) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'NOT_FOUND' })); return; }
    const rest = url.slice(mount[0].length);
    req.url = rest.startsWith('/') ? rest : `/${rest}`;
    Promise.resolve().then(() => mount[1](req, res)).catch(() => {
      // An unexpected failure: answer 500 if nothing was sent yet, otherwise end the response.
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    });
  }

  return {
    handle,
    close() {
      closed = true;
      if (courseRunner.status().running) courseRunner.cancel();
      discovery.cancel();
    },
    syncRunning: () => courseRunner.status().running,
  };
}
