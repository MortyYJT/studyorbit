import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CDP_BROWSERS, closeCdpBrowser, ensureProfileDir, findBrowserExecutable, launchArgs, PROFILE_IN_USE, profileDirFor, startCdpBrowser, type SpawnLike,
} from '../scripts/browser/cdp-launch.mjs';

// Launching the experimental CDP bridge's dedicated browser (openspec change generic-adapters, design §7, decision
// #446): executable lookup with a fake file system, launch arguments, profile directory, handover detection and the
// close-then-kill sequence with a fake child process. Never a real browser.

const files = (...paths: string[]) => async (path: string) => paths.includes(path);

describe('executable lookup', () => {
  it('uses the browser path from the settings when it exists, and refuses it otherwise', async () => {
    expect(await findBrowserExecutable({ id: 'cdp-chrome', browserPath: '/opt/chrome/chrome', platform: 'linux', env: {}, isFile: files('/opt/chrome/chrome') })).toBe('/opt/chrome/chrome');
    await expect(findBrowserExecutable({ id: 'cdp-chrome', browserPath: '/opt/chrome/chrome', platform: 'linux', env: {}, isFile: files() })).rejects.toThrow('找不到设置里的浏览器程序');
  });

  it('finds Chrome and Edge under Program Files, Program Files (x86) and Local AppData on Windows', async () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LocalAppData: 'C:\\Users\\student\\AppData\\Local' };
    const chrome86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    const edgeLocal = 'C:\\Users\\student\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(await findBrowserExecutable({ id: 'cdp-chrome', browserPath: null, platform: 'win32', env, isFile: files(chrome86, edgeLocal) })).toBe(chrome86);
    expect(await findBrowserExecutable({ id: 'cdp-edge', browserPath: null, platform: 'win32', env, isFile: files(chrome86, edgeLocal) })).toBe(edgeLocal);
    const first = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    expect(await findBrowserExecutable({ id: 'cdp-chrome', browserPath: null, platform: 'win32', env, isFile: files(chrome86, first) })).toBe(first);
    await expect(findBrowserExecutable({ id: 'cdp-edge', browserPath: null, platform: 'win32', env, isFile: files(chrome86) })).rejects.toThrow('找不到 Microsoft Edge');
  });

  it('searches the absolute PATH entries on Linux for the known program names', async () => {
    const env = { PATH: 'relative/bin:/usr/local/bin:/usr/bin' };
    expect(await findBrowserExecutable({ id: 'cdp-chrome', browserPath: null, platform: 'linux', env, isFile: files('/usr/bin/google-chrome-stable', '/usr/local/bin/chromium') })).toBe('/usr/local/bin/chromium');
    expect(await findBrowserExecutable({ id: 'cdp-chrome', browserPath: null, platform: 'linux', env, isFile: files('/usr/bin/google-chrome-stable') })).toBe('/usr/bin/google-chrome-stable');
    expect(await findBrowserExecutable({ id: 'cdp-edge', browserPath: null, platform: 'linux', env, isFile: files('/usr/bin/microsoft-edge') })).toBe('/usr/bin/microsoft-edge');
    // A relative PATH entry depends on the working directory and is never searched.
    await expect(findBrowserExecutable({ id: 'cdp-chrome', browserPath: null, platform: 'linux', env, isFile: files('relative/bin/google-chrome') })).rejects.toThrow('找不到 Google Chrome');
    expect(CDP_BROWSERS['cdp-edge'].linux).not.toContain('chromium');
  });

  it('refuses an unknown bridge id', async () => {
    await expect(findBrowserExecutable({ id: 'edge-applescript', browserPath: null, platform: 'linux', env: {}, isFile: files() })).rejects.toThrow('未知的专用浏览器');
  });
});

describe('launch arguments and profile directory', () => {
  it('uses a pipe and the dedicated profile, never a port', () => {
    const profile = profileDirFor('C:\\Users\\student\\studyorbit', 'cdp-chrome', 'win32');
    expect(profile).toBe('C:\\Users\\student\\studyorbit\\.local\\browser\\cdp-chrome');
    const args = launchArgs(profile);
    expect(args).toEqual(['--remote-debugging-pipe', '--user-data-dir=C:\\Users\\student\\studyorbit\\.local\\browser\\cdp-chrome', '--no-first-run', '--no-default-browser-check', 'about:blank']);
    expect(args.some(arg => arg.includes('remote-debugging-port') || arg.includes('remote-debugging-address'))).toBe(false);
    expect(profileDirFor('/home/student/studyorbit', 'cdp-edge', 'linux')).toBe('/home/student/studyorbit/.local/browser/cdp-edge');
    expect(() => profileDirFor('/p', 'chrome-applescript', 'linux')).toThrow();
  });

  it('creates the profile directory owner-only and tightens an existing one off Windows', async () => {
    const calls: string[] = [];
    const fs = { mkdir: async (path: string, options: { recursive: boolean; mode: number }) => { calls.push(`mkdir ${path} ${options.mode.toString(8)} ${options.recursive}`); return undefined; },
      chmod: async (path: string, mode: number) => { calls.push(`chmod ${path} ${mode.toString(8)}`); } };
    await ensureProfileDir('/p/.local/browser/cdp-chrome', { platform: 'linux', fs });
    expect(calls).toEqual(['mkdir /p/.local/browser/cdp-chrome 700 true', 'chmod /p/.local/browser/cdp-chrome 700']);
    calls.length = 0;
    await ensureProfileDir('C:\\p\\.local\\browser\\cdp-chrome', { platform: 'win32', fs });
    expect(calls).toEqual(['mkdir C:\\p\\.local\\browser\\cdp-chrome 700 true']);
  });
});

/** A fake browser process: fd 3 collects commands, fd 4 replies; `answer` decides the reply to each command. */
function fakeBrowser(answer: (command: { id: number; method: string }) => unknown | null = () => ({})) {
  const child = new EventEmitter() as EventEmitter & { stdio: unknown[]; kill(signal?: string): boolean; pid: number; killed: string[] };
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
  const commands: { id: number; method: string }[] = [];
  child.stdio = [null, null, null, toBrowser, fromBrowser];
  child.pid = 4242;
  child.killed = [];
  child.kill = (signal = 'SIGTERM') => { child.killed.push(signal); return true; };
  toBrowser.on('data', (chunk: Buffer) => {
    for (const text of chunk.toString('utf8').split('\0').filter(Boolean)) {
      const command = JSON.parse(text);
      commands.push(command);
      const result = answer(command);
      if (result !== null) fromBrowser.write(`${JSON.stringify({ id: command.id, result })}\0`);
    }
  });
  const exit = (code: number | null, signal: string | null = null) => { fromBrowser.end(); child.emit('exit', code, signal); };
  return { child, commands, exit };
}

describe('starting and closing the browser', () => {
  const base = { id: 'cdp-chrome' as const, projectDir: '/p', browserPath: '/opt/chrome/chrome', platform: 'linux', env: {}, isFile: files('/opt/chrome/chrome'),
    fs: { mkdir: async () => undefined, chmod: async () => undefined } };

  it('spawns the executable with the pipe file descriptors and waits for a first answer', async () => {
    const browser = fakeBrowser();
    const spawned: unknown[] = [];
    const spawn: SpawnLike = (file, args, options) => { spawned.push({ file, args, stdio: options.stdio }); return browser.child as never; };
    const started = await startCdpBrowser({ ...base, spawn, lockExists: async () => false });
    expect(spawned).toEqual([{ file: '/opt/chrome/chrome', args: launchArgs('/p/.local/browser/cdp-chrome'), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }]);
    expect(browser.commands.map(command => command.method)).toEqual(['Target.getTargetInfo']);
    expect(started.running()).toBe(true);
    browser.exit(0);
    await started.exited;
    expect(started.running()).toBe(false);
  });

  it('detects a handover to a browser already running with the profile', async () => {
    const browser = fakeBrowser(() => null);
    const spawn: SpawnLike = () => { setImmediate(() => browser.exit(0)); return browser.child as never; };
    const locks: string[] = [];
    await expect(startCdpBrowser({ ...base, spawn, lockExists: async (path: string) => { locks.push(path); return true; } })).rejects.toThrow(PROFILE_IN_USE);
    expect(locks).toEqual(['/p/.local/browser/cdp-chrome/SingletonLock']);
    const windows = fakeBrowser(() => null);
    const winSpawn: SpawnLike = () => { setImmediate(() => windows.exit(0)); return windows.child as never; };
    const winLocks: string[] = [];
    await expect(startCdpBrowser({ ...base, platform: 'win32', projectDir: 'C:\\p', browserPath: 'C:\\c\\chrome.exe', isFile: files('C:\\c\\chrome.exe'), spawn: winSpawn,
      lockExists: async (path: string) => { winLocks.push(path); return true; } })).rejects.toThrow(PROFILE_IN_USE);
    expect(winLocks).toEqual(['C:\\p\\.local\\browser\\cdp-chrome\\lockfile']);
  });

  it('reports a browser that exits without a profile lock, or never answers, as a failed launch', async () => {
    const crashed = fakeBrowser(() => null);
    await expect(startCdpBrowser({ ...base, spawn: () => { setImmediate(() => crashed.exit(13)); return crashed.child as never; }, lockExists: async () => false }))
      .rejects.toThrow('专用浏览器启动失败');
    const silent = fakeBrowser(() => null);
    silent.child.kill = (signal = 'SIGTERM') => { silent.child.killed.push(signal); setImmediate(() => silent.exit(null, signal)); return true; };
    await expect(startCdpBrowser({ ...base, spawn: () => silent.child as never, lockExists: async () => false, startTimeoutMs: 20, exitGraceMs: 20 })).rejects.toThrow('专用浏览器启动失败');
    expect(silent.child.killed).toEqual(['SIGKILL']);
    const missing = new EventEmitter() as EventEmitter & { stdio: unknown[]; kill(): boolean };
    missing.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    missing.kill = () => true;
    await expect(startCdpBrowser({ ...base, spawn: () => { setImmediate(() => missing.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return missing as never; }, lockExists: async () => false }))
      .rejects.toThrow('专用浏览器启动失败');
  });

  it('closes with Browser.close and kills the process after 5 s if it is still running', async () => {
    const polite = fakeBrowser(command => { if (command.method === 'Browser.close') setImmediate(() => polite.exit(0)); return {}; });
    const started = await startCdpBrowser({ ...base, spawn: () => polite.child as never, lockExists: async () => false });
    const waits: number[] = [];
    await closeCdpBrowser(started, { sleep: async ms => { waits.push(ms); await new Promise(resolve => setTimeout(resolve, 50)); } });
    expect(polite.commands.map(command => command.method)).toEqual(['Target.getTargetInfo', 'Browser.close']);
    expect(polite.child.killed).toEqual([]);

    const stubborn = fakeBrowser(command => (command.method === 'Browser.close' ? null : {}));
    stubborn.child.kill = (signal = 'SIGTERM') => { stubborn.child.killed.push(signal); setImmediate(() => stubborn.exit(null, signal)); return true; };
    const second = await startCdpBrowser({ ...base, spawn: () => stubborn.child as never, lockExists: async () => false });
    const sleeps: number[] = [];
    await closeCdpBrowser(second, { sleep: async ms => { sleeps.push(ms); } });
    expect(sleeps[0]).toBe(5000);
    expect(stubborn.child.killed).toEqual(['SIGKILL']);
    await second.exited;
    expect(second.running()).toBe(false);
    // Closing again, or a browser that already exited, sends nothing.
    await closeCdpBrowser(second, { sleep: async () => {} });
    expect(stubborn.commands.filter(command => command.method === 'Browser.close')).toHaveLength(1);
  });
});
