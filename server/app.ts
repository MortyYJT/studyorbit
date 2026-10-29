// The local API as a plain Node request handler (design §2): the access guard (§3) in front of the route table. Each
// route keeps the path, methods, status codes, bodies, error codes and body limits it had in `vite.config.ts`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncPipeline, type PipelineDeps, type SyncPipeline } from '../scripts/lib/sync-pipeline.mjs';
import { loadSourceSetup } from '../scripts/lib/source-settings.mjs';
import { canvasSource } from '../scripts/sources/registry.mjs';
import type { OpenResult } from '../scripts/lib/sync-store.mjs';
import type { Env, RouteContext, RouteHandler } from './context.ts';
import { checkRequest } from './guard.ts';
import { chatsRoute } from './routes/chats.ts';
import { correctionsRoute } from './routes/corrections.ts';
import { courseCandidatesRoute } from './routes/course-candidates.ts';
import { courseChangesRoute } from './routes/course-changes.ts';
import { courseReportsRoute } from './routes/course-reports.ts';
import { courseSyncRoute } from './routes/course-sync.ts';
import { llmConfigRoute } from './routes/llm-config.ts';
import { revisionNotesRoute } from './routes/revision-notes.ts';
import { sourceSettingsRoute } from './routes/source-settings.ts';
import { syncCoursesRoute } from './routes/sync-courses.ts';
import { syncJobsRoute } from './routes/sync-jobs.ts';
import { syncUsageRoute } from './routes/sync-usage.ts';

export const API_PREFIX = '/api/local';
const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));

export type LocalApiOptions = {
  projectDir: string;
  /** Defaults to `~/Desktop`. */
  desktopDir?: string;
  /** Per-launch token every request must carry in `x-studyorbit-token`. */
  token: string;
  /** Port of the page (Vite); the only port accepted in `Host`. */
  webPort: number;
  /** Result of `openSyncStore`; without an open store the sync routes answer 503 SYNC_STORE_UNAVAILABLE. */
  store?: OpenResult;
  /** Defaults to `process.env`. */
  env?: Env;
  /** Defaults to `process.platform`; tests choose one so the default browser does not depend on the machine. */
  platform?: string;
  /** Test seam for the browser-path check of the source settings. */
  isFile?: (path: string) => Promise<boolean>;
  /**
   * Test seams: fake collectors, model, clock and IDs for the sync pipeline, and a stub discovery script. Real ones by
   * default. Hooks cannot be passed here: the server never creates the pipeline with hooks (design §10).
   */
  pipelineDeps?: Omit<Partial<PipelineDeps>, 'store' | 'projectDir' | 'desktopDir' | 'hooks'>;
  discoveryScript?: string;
};

export type LocalApi = {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Stops a running course sync (marked `interrupted`) and course discovery; later requests get 503 (shutting down). */
  close(): void;
  /** True while a course sync is running. */
  syncRunning(): boolean;
};

export function createLocalApi(options: LocalApiOptions): LocalApi {
  const platform = options.platform ?? process.platform;
  const context: RouteContext = {
    projectDir: options.projectDir,
    desktopDir: options.desktopDir ?? join(homedir(), 'Desktop'),
    env: options.env ?? process.env,
    platform,
    // The source settings (generic-adapters design §8) are read once per sync, per discovery and per request.
    sourceSetup: () => loadSourceSetup(options.projectDir, { platform }),
  };
  const pipeline: SyncPipeline | null = options.store?.ok
    ? createSyncPipeline({ setup: context.sourceSetup, ...options.pipelineDeps, hooks: undefined, store: options.store.store, projectDir: context.projectDir, desktopDir: context.desktopDir, env: context.env })
    : null;
  const discovery = syncCoursesRoute(context, async out => {
    const setup = await context.sourceSetup();
    const command = canvasSource.discover(setup.context, out);
    return { ...command, script: options.discoveryScript ?? join(SCRIPTS_DIR, command.script) };
  });
  const busy = () => (pipeline?.running() ?? false) || discovery.running();
  const routes: [string, RouteHandler][] = [
    ['sync-usage', syncUsageRoute(context)],
    ['llm-config', llmConfigRoute(context)],
    ['course-reports', courseReportsRoute(context)],
    ['corrections', correctionsRoute(context)],
    ['course-changes', courseChangesRoute(context)],
    ['revision-notes', revisionNotesRoute(context)],
    ['chats', chatsRoute(context)],
    ['course-sync', courseSyncRoute(pipeline)],
    ['sync-jobs', syncJobsRoute(pipeline)],
    ['sync-courses', discovery.route],
    ['course-candidates', courseCandidatesRoute(context)],
    ['source-settings', sourceSettingsRoute(context, busy, options.isFile)],
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
      void pipeline?.shutdown();
      discovery.cancel();
    },
    syncRunning: () => pipeline?.running() ?? false,
  };
}
