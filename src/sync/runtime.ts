import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../config/data-dir.js';
import { acquireProfileLock, processIsAlive } from '../capture/lock.js';
import type { Page } from 'playwright';
import { CourseworkError } from '../protocol/errors.js';
import { withResidentBrowser, type BrowserSession } from '../browser/attach.js';
import { CanvasTransport } from '../capture/canvas-transport.js';
import { EdTransport } from '../capture/ed-transport.js';
import { writeEdSnapshot } from '../capture/ed-snapshot.js';
import { writeCanvasSnapshot } from '../capture/sync-snapshot.js';
import { SyncService } from './service.js';
import type { SqliteRepository } from '../store/sqlite.js';
import type { CaptureLimiter, RequestClock } from '../capture/limiter.js';
import type { JsonReader } from './canvas-reader.js';
/** Connect only on a manual run; the resident context is never launched or closed by sync. */
export interface SyncRuntimeOptions { home?: string; clock?: RequestClock; attach?: <T>(operation: (session: BrowserSession<Page>) => Promise<T>) => Promise<T> }
export function productionSync(store: SqliteRepository, options: SyncRuntimeOptions = {}) {
  const home = () => options.home ?? dataDir();
  const directory = () => join(home(), 'profiles');
  const isRunning = () => {
    try { const holder = readFileSync(join(directory(), 'sync.lock'), 'utf8'); return /^[1-9]\d*$/.test(holder) && processIsAlive(Number(holder)); } catch { return false; }
  };
  let active = false;
  let operation: ((limiter: CaptureLimiter) => Promise<{ canvas: JsonReader; ed: JsonReader }>) | undefined;
  const service = new SyncService({ store, clock: options.clock, lock: () => {
    const path = directory(); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
    return acquireProfileLock({ directory: path, name: 'sync.lock' });
  }, readers: async limiter => {
    if (!operation) throw new Error('Missing resident connection.');
    return operation(limiter);
  } });
  return {
    status: () => ({ ...service.status(), running: active || isRunning() }),
    run: async (input: { course?: string }) => {
      if (active) throw new CourseworkError('LOCKED', 'A sync is already running.');
      active = true;
      // Lock before connecting, including across independent CLI and HTTP processes.
      const readers = async (limiter: CaptureLimiter) => {
        const canvasPage = await session!.newPage(); const edPage = await session!.newPage();
        const canvas = new CanvasTransport(canvasPage, limiter); const ed = new EdTransport(edPage, limiter);
        return { canvas: { read: async (endpoint: string) => {
          const response = await canvas.read(endpoint);
          if (response.kind === 'json') { try { await writeCanvasSnapshot(endpoint, response.body, response.status, home()); } catch { return { kind: 'gap' as const, reason: 'snapshot' as const }; } }
          return response;
        } }, ed: { read: (endpoint: string) => ed.read(endpoint, { snapshot: async (endpoint, body, status) => { await writeEdSnapshot(endpoint, body, status, home()); } }) } };
      };
      let session: BrowserSession<Page> | undefined;
      // Connection is established lazily inside the locked service operation.
      let disconnect!: () => void;
      const finished = new Promise<void>(resolve => { disconnect = resolve; });
      let connection: Promise<unknown> | undefined;
      operation = async limiter => {
        let ready!: () => void; let failed!: (error: unknown) => void;
        const connected = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
        connection = (options.attach ?? (operation => withResidentBrowser({}, operation)))(async current => { session = current; ready(); await finished; }).catch(error => { failed(error); throw error; });
        // Keep a rejection handler attached until cleanup, without swallowing cleanup failures.
        void connection.catch(() => {});
        await connected; return readers(limiter);
      };
      try { return await service.run(input); }
      finally { disconnect(); try { await connection; } catch (error) { if (session) throw error; } finally { operation = undefined; active = false; } }
    },
  };
}
