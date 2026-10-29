// Launching the dedicated browser of the experimental CDP bridge (openspec change generic-adapters, design §7,
// decision #446). The installed Chrome or Edge is started with `--remote-debugging-pipe` and a dedicated profile under
// `<project>/.local/browser/<bridge>` (owner-only); no debugging port is ever opened. A first command over the pipe
// proves the browser is ours: when a browser with that profile is already running, the new process hands its command
// line over and exits, which is reported as 「StudyOrbit 专用浏览器已在运行，请先关闭它」. Closing sends
// `Browser.close` and kills the process after 5 s. Spawning and the file system are injectable; tests never start a
// browser. Not verified on Windows or Linux.
import { spawn as nodeSpawn } from 'node:child_process';
import { chmod, lstat, mkdir, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { createCdpPipe } from './cdp-pipe.mjs';

/** Where each CDP bridge's browser is installed. Linux names are searched on PATH. */
export const CDP_BROWSERS = Object.freeze({
  'cdp-chrome': Object.freeze({
    label: 'Google Chrome',
    windows: 'Google\\Chrome\\Application\\chrome.exe',
    linux: Object.freeze(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']),
    darwin: Object.freeze(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
  }),
  'cdp-edge': Object.freeze({
    label: 'Microsoft Edge',
    windows: 'Microsoft\\Edge\\Application\\msedge.exe',
    linux: Object.freeze(['microsoft-edge', 'microsoft-edge-stable']),
    darwin: Object.freeze(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']),
  }),
});
/** Install roots on Windows, in search order. */
const WINDOWS_ROOTS = Object.freeze(['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData']);
export const PROFILE_IN_USE = 'StudyOrbit 专用浏览器已在运行，请先关闭它';
export const START_TIMEOUT_MS = 15000;
export const KILL_AFTER_MS = 5000;

const browserOf = id => {
  if (!Object.hasOwn(CDP_BROWSERS, id)) throw new Error(`未知的专用浏览器：${String(id)}`);
  return CDP_BROWSERS[id];
};
const pathFor = platform => (platform === 'win32' ? win32 : posix);
/** An environment variable by name, ignoring case as Windows does. */
const envValue = (env, name) => {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
};

async function isRegularFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/**
 * The browser program: `browserPath` from the settings when given (it must exist), else the first known install
 * location: Program Files, Program Files (x86) and Local AppData on Windows; the program names on the absolute PATH
 * entries on Linux; the application bundle on macOS.
 */
export async function findBrowserExecutable({ id, browserPath, platform = process.platform, env = process.env, isFile = isRegularFile }) {
  const browser = browserOf(id);
  if (browserPath) {
    if (await isFile(browserPath)) return browserPath;
    throw new Error(`找不到设置里的浏览器程序：${browserPath}`);
  }
  let candidates;
  if (platform === 'win32') {
    candidates = WINDOWS_ROOTS.map(name => envValue(env, name)).filter(root => typeof root === 'string' && win32.isAbsolute(root)).map(root => win32.join(root, browser.windows));
  } else if (platform === 'darwin') {
    candidates = [...browser.darwin];
  } else {
    const dirs = String(envValue(env, 'PATH') ?? '').split(posix.delimiter).filter(dir => posix.isAbsolute(dir));
    candidates = dirs.flatMap(dir => browser.linux.map(name => posix.join(dir, name)));
  }
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  throw new Error(`找不到 ${browser.label}，请在设置里填写浏览器程序的完整路径`);
}

/** The dedicated profile directory of a bridge: `<project>/.local/browser/<bridge>`. */
export function profileDirFor(projectDir, id, platform = process.platform) {
  browserOf(id);
  return pathFor(platform).join(projectDir, '.local', 'browser', id);
}

/** The launch arguments: the pipe, the dedicated profile, no first-run prompts, a blank start page. Never a port. */
export function launchArgs(profileDir, extraArgs = []) {
  return ['--remote-debugging-pipe', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', ...extraArgs, 'about:blank'];
}

/** Creates the profile directory owner-only (0700); off Windows an existing directory is tightened too. */
export async function ensureProfileDir(dir, { platform = process.platform, fs = { mkdir, chmod } } = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') await fs.chmod(dir, 0o700);
}

/** The lock a running Chrome or Edge keeps in its profile: `SingletonLock` (a symlink) off Windows, `lockfile` on Windows. */
export const profileLockFile = (profileDir, platform) => pathFor(platform).join(profileDir, platform === 'win32' ? 'lockfile' : 'SingletonLock');

async function pathExists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

const realSleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

/**
 * Starts the dedicated browser and returns `{ id, browserPath, pipe, child, exited, running() }` once it has answered
 * a first command (`Target.getTargetInfo` of the browser target). A process that exits first while its profile is
 * locked handed over to a browser already running with that profile: `PROFILE_IN_USE`. Any other early exit, a spawn
 * error or no answer within `startTimeoutMs` fails the launch (a silent process is killed).
 */
export async function startCdpBrowser({
  id, projectDir, browserPath = null, platform = process.platform, env = process.env, isFile = isRegularFile, fs, spawn = nodeSpawn,
  lockExists = pathExists, startTimeoutMs = START_TIMEOUT_MS, exitGraceMs = 2000, extraArgs = [],
}) {
  const browser = browserOf(id);
  const executable = await findBrowserExecutable({ id, browserPath, platform, env, isFile });
  const profileDir = profileDirFor(projectDir, id, platform);
  await ensureProfileDir(profileDir, { platform, ...(fs ? { fs } : {}) });
  const child = spawn(executable, launchArgs(profileDir, extraArgs), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let alive = true;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => { alive = false; resolve({ code, signal, error: null }); });
    child.once('error', error => { alive = false; resolve({ code: null, signal: null, error }); });
  });
  const pipe = createCdpPipe({ input: child.stdio[4], output: child.stdio[3] });
  const started = { id, browserPath, pipe, child, exited, running: () => alive };

  let timer;
  const outcome = await Promise.race([
    pipe.send('Target.getTargetInfo', {}).then(() => 'ready', () => 'failed'),
    exited.then(() => 'exited'),
    new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), startTimeoutMs); }),
  ]);
  clearTimeout(timer);
  if (outcome === 'ready') return started;

  // A handover closes the pipe and exits almost together; give the exit a moment to arrive.
  if (alive) await Promise.race([exited, realSleep(exitGraceMs)]);
  if (alive) {
    try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
    pipe.dispose();
    throw new Error(`专用浏览器启动失败：${browser.label} 没有响应`);
  }
  pipe.dispose();
  const exit = await exited;
  if (exit.error) throw new Error(`专用浏览器启动失败：无法运行 ${browser.label}（${exit.error.code ?? exit.error.message}）`);
  if (await lockExists(profileLockFile(profileDir, platform))) throw new Error(PROFILE_IN_USE);
  throw new Error(`专用浏览器启动失败：${browser.label} 已退出（${exit.code ?? exit.signal}）`);
}

/** Closes a started browser: `Browser.close`, then kill after `killAfterMs` if it is still running. */
export async function closeCdpBrowser(started, { killAfterMs = KILL_AFTER_MS, sleep = realSleep } = {}) {
  if (!started.running()) { started.pipe.dispose(); return; }
  started.pipe.send('Browser.close', {}).catch(() => { /* The exit below decides. */ });
  const first = await Promise.race([started.exited.then(() => 'exited'), sleep(killAfterMs).then(() => 'timeout')]);
  if (first === 'timeout' && started.running()) {
    try { started.child.kill('SIGKILL'); } catch { /* Already gone. */ }
    await Promise.race([started.exited, sleep(1000)]);
  }
  started.pipe.dispose();
}
