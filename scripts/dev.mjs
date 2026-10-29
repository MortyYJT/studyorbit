// `npm run dev`: starts the local API server, then Vite once the server is listening (design §4, decision #357).
// A random 32-byte token is created per launch and given to both processes in STUDYORBIT_API_TOKEN (never printed or
// written). The server's stdout is piped and echoed line by line so the listening line can be seen; Vite inherits
// the terminal. SIGINT/SIGTERM are forwarded to both; when one exits the other is stopped; the exit code is the first
// non-zero one. No dependencies and no file watching (a restart would interrupt a running sync).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const LISTENING_PREFIX = 'StudyOrbit local API listening on ';
export const START_TIMEOUT_MS = 15000;

/**
 * Runs `server`, then `web` after the server prints the listening line. `done` resolves with the exit code once every
 * started process has exited; `signal(name)` forwards a signal to both.
 */
export function startLauncher({ server, web, env, out = process.stdout, log = line => console.error(line), startTimeoutMs = START_TIMEOUT_MS, cwd }) {
  const children = new Map();
  const gone = new Set();
  const signalled = new Set();
  let exitCode = null;
  let stopping = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  const settle = code => { if (exitCode === null || exitCode === 0) exitCode = code; };
  const stopOthers = except => {
    for (const [name, child] of children) {
      if (name === except || gone.has(name)) continue;
      signalled.add(name);
      child.kill('SIGTERM');
    }
  };
  const finishIfIdle = () => {
    if (gone.size === children.size) resolveDone(exitCode ?? 0);
  };
  const track = (name, child) => {
    children.set(name, child);
    child.on('error', error => {
      log(`无法启动 ${name}：${error.message}`);
      settle(1);
      stopOthers(name);
      // A process that never spawned emits no exit event.
      if (child.pid === undefined) { gone.add(name); finishIfIdle(); }
    });
    child.on('exit', (code, signal) => {
      gone.add(name);
      // A process stopped by a signal we sent counts as a clean stop; any other signal is a failure.
      settle(code ?? (signal && signalled.has(name) ? 0 : 1));
      stopOthers(name);
      finishIfIdle();
    });
  };

  const serverChild = spawn(server.command, server.args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let webStarted = false;
  // Registered before `track`, so an exit during startup is a failure even with exit code 0.
  serverChild.on('exit', code => {
    clearTimeout(timer);
    // A failed start, unless it was stopped by a forwarded signal or the start timeout (already reported).
    if (!webStarted && !signalled.has('server')) { log('本地接口服务启动失败，没有启动页面服务。'); settle(code || 1); }
  });
  track('server', serverChild);
  const timer = setTimeout(() => {
    if (webStarted) return;
    log(`本地接口服务 ${startTimeoutMs / 1000} 秒内没有开始监听，已停止。`);
    settle(1);
    stopOthers();
  }, startTimeoutMs);
  createInterface({ input: serverChild.stdout, crlfDelay: Infinity }).on('line', line => {
    out.write(`${line}\n`);
    if (webStarted || stopping || !line.startsWith(LISTENING_PREFIX) || exitCode !== null) return;
    webStarted = true;
    clearTimeout(timer);
    track('web', spawn(web.command, web.args, { cwd, env, stdio: 'inherit' }));
  });

  return {
    done,
    signal(name) {
      stopping = true;
      for (const [childName, child] of children) {
        if (gone.has(childName)) continue;
        signalled.add(childName);
        child.kill(name);
      }
    },
  };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = {
    ...process.env,
    STUDYORBIT_API_TOKEN: randomBytes(32).toString('hex'),
    STUDYORBIT_API_PORT: process.env.STUDYORBIT_API_PORT ?? '5190',
    STUDYORBIT_WEB_PORT: process.env.STUDYORBIT_WEB_PORT ?? '5173',
  };
  const launcher = startLauncher({
    cwd: root,
    env,
    server: { command: process.execPath, args: [fileURLToPath(new URL('../server/main.ts', import.meta.url))] },
    // Extra arguments (`npm run dev -- --open`) go to Vite. Change the page port with STUDYORBIT_WEB_PORT, not --port:
    // the server only accepts the page's own port in Host.
    web: { command: process.execPath, args: [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), ...process.argv.slice(2)] },
  });
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => launcher.signal(name));
  process.exitCode = await launcher.done;
}
