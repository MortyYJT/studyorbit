// Entry point of the standalone local API (`npm run server`, normally started by `npm run dev`; design §2, §5, §8).
// Order: parse the environment, take the single-instance lock, open the sync store (an unusable database keeps the
// server up with the sync routes answering 503), listen on 127.0.0.1 only, print one listening line. Opening the store
// marks jobs left `running` by a dead server `interrupted`. SIGINT/SIGTERM stop a running sync and mark it
// `interrupted` (resumable), wait for it to settle, close everything and exit.
// The token is never printed or written anywhere.
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistant } from '../scripts/lib/deeptutor.mjs';
import { resolveAnalysisConfig } from '../scripts/lib/llm-config.mjs';
import { acquireServerLock } from '../scripts/lib/server-lock.mjs';
import { openSyncStore } from '../scripts/lib/sync-store.mjs';
import { createLocalApi } from './app.ts';
import type { Env } from './context.ts';
import { createLlmProxy } from './llm-proxy.ts';
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, parsePort } from './ports.ts';

export const LISTENING_LINE = 'StudyOrbit local API listening on';
/**
 * Longest wait for an interrupted sync to settle on shutdown: a little longer than the collectors' 5 s SIGTERM → SIGKILL
 * escalation for their process groups, so that escalation runs before this process exits.
 */
const SHUTDOWN_WAIT_MS = 6000;

export function parseServerEnv(env: Env): { token: string; apiPort: number; webPort: number } {
  const token = env.STUDYORBIT_API_TOKEN;
  if (!token || !/^[0-9a-f]{32,}$/i.test(token)) {
    throw new Error('STUDYORBIT_API_TOKEN 缺失或无效（至少 32 位十六进制字符）。请用 npm run dev 启动。');
  }
  return { token, apiPort: parsePort(env, 'STUDYORBIT_API_PORT', DEFAULT_API_PORT), webPort: parsePort(env, 'STUDYORBIT_WEB_PORT', DEFAULT_WEB_PORT) };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`端口 ${port} 已被占用。请关闭占用它的程序，或用 STUDYORBIT_API_PORT 指定另一个端口（不会自动换端口）。`)
        : error);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

export type RunningServer = { port: number; stop(): Promise<void> };

export async function startServer({ projectDir, desktopDir, env = process.env, warn = (line: string) => console.error(line), withAssistant = false }:
  { projectDir: string; desktopDir?: string; env?: Env; warn?: (line: string) => void; /** Also start DeepTutor (decision #549); `main()` does, tests of the server do not. */ withAssistant?: boolean }): Promise<RunningServer> {
  const { token, apiPort, webPort } = parseServerEnv(env);
  const lock = acquireServerLock(projectDir);
  let store: Awaited<ReturnType<typeof openSyncStore>> | undefined;
  const server = createServer();
  try {
    store = await openSyncStore({ projectDir });
    if (!store.ok) warn(`同步记录数据库不可用（${store.error}: ${store.reason}），同步接口将返回 503，其他功能照常。`);
    // The assistant (DeepTutor) lives and dies with this server. It starts in the background after the server is
    // listening; whatever goes wrong becomes its status, never a failed start of the server.
    const assistant = withAssistant && env.STUDYORBIT_DEEPTUTOR !== 'off'
      ? createAssistant({
        projectDir, desktopDir: desktopDir ?? join(homedir(), 'Desktop'), webPort, env, log: warn,
        createProxy: ({ token: launchToken, upstream }) => createLlmProxy({ token: launchToken, upstream, log: warn, resolveKey: async () => (await resolveAnalysisConfig(projectDir, env)).apiKey ?? null }),
      })
      : undefined;
    const api = createLocalApi({ projectDir, desktopDir, token, webPort, store, env, assistant });
    server.on('request', api.handle);
    const port = await listen(server, apiPort);
    void assistant?.start();
    let stopping: Promise<void> | undefined;
    const stop = () => (stopping ??= (async () => {
      // Stop accepting connections, refuse requests on open ones, then interrupt the sync.
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      // Also closes the dedicated browser of the CDP bridge, if one runs (Browser.close, killed after 5 s).
      const browserClosed = api.close();
      const assistantStopped = assistant?.stop().catch(() => { /* Its processes are signalled either way. */ });
      const deadline = Date.now() + SHUTDOWN_WAIT_MS;
      while (api.syncRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      server.closeAllConnections();
      await closed;
      await browserClosed.catch(() => { /* The browser process is gone either way. */ });
      await assistantStopped;
      if (store?.ok) store.store.close();
      lock.release();
    })());
    return { port, stop };
  } catch (error) {
    server.close();
    if (store?.ok) store.store.close();
    lock.release();
    throw error;
  }
}

/** CLI: start, print the listening line, stop on SIGINT/SIGTERM; any startup error exits with code 1. */
export async function main({ projectDir = fileURLToPath(new URL('../', import.meta.url)) }: { projectDir?: string } = {}) {
  // Install the signal handlers before any await. Without a listener a signal takes the default action and kills the
  // process with no cleanup, and the listening line used to be written before the handlers existed, so a supervisor
  // reacting to that line could signal into that gap. A signal during startup stops the server once it has started.
  let running: RunningServer | undefined;
  let stopRequested = false;
  const shutdown = () => {
    stopRequested = true;
    if (running) void running.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    running = await startServer({ projectDir, withAssistant: true });
  } catch (error) {
    console.error(`StudyOrbit 本地服务无法启动：${(error as Error).message}`);
    process.exit(1);
  }
  if (stopRequested) {
    shutdown();
    return;
  }
  console.log(`${LISTENING_LINE} http://127.0.0.1:${running.port}`);
}

if (import.meta.main) await main();
