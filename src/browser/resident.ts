import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { z } from 'zod';
import { resolveDataDir } from '../config/data-dir.js';
import { browserExecutablePaths, chooseBrowser, isBrowserInstalled, recordBrowser, type CaptureBrowser } from '../capture/browser.js';
import { acquireProfileLock, processIsAlive, releaseProfileLock } from '../capture/lock.js';
import type { RequestClock } from '../capture/limiter.js';
import { CourseworkError } from '../protocol/errors.js';

const stateSchema = z.strictObject({
  endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/).refine(value => Number(new URL(value).port) <= 65535),
  pid: z.number().int().positive().safe(), browser: z.enum(['msedge', 'chrome', 'chromium']), startedAt: z.iso.datetime(),
});
export type BrowserState = z.infer<typeof stateSchema>;
const processSchema = stateSchema.extend({ endpoint: stateSchema.shape.endpoint.optional() });
type BrowserProcess = z.infer<typeof processSchema>;
export const browserClock: RequestClock = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export interface ResidentOptions {
  directory?: string; clock?: RequestClock; ownerPid?: number; timeoutMs?: number;
  launch?: (executable: string, args: string[]) => Promise<number>;
  terminate?: (pid: number) => Promise<void>; isAlive?: (pid: number) => boolean;
  executable?: (browser: CaptureBrowser) => string; isInstalled?: (browser: CaptureBrowser) => boolean;
  watchExit?: (state: BrowserProcess, directory: string) => Promise<void>;
  override?: string; isTTY?: boolean; confirm?: () => Promise<boolean>;
}
function unavailable(): CourseworkError { return new CourseworkError('SOURCE_UNAVAILABLE', 'Resident browser unavailable.'); }
async function launch(executable: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => reject(unavailable()));
    child.once('spawn', () => { child.unref(); if (child.pid) resolve(child.pid); else reject(unavailable()); });
  });
}
async function watchExit(state: BrowserProcess, directory: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./watch.js', import.meta.url)), directory, String(state.pid)], {
      detached: true, stdio: 'ignore',
    });
    child.once('error', () => reject(unavailable()));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
/** Private host service. Never serialize BrowserState into an agent envelope or diagnostic. */
export class ResidentBrowser {
  private readonly clock: RequestClock;
  private readonly alive: (pid: number) => boolean;
  constructor(private readonly options: ResidentOptions = {}) {
    this.clock = options.clock ?? browserClock; this.alive = options.isAlive ?? processIsAlive;
  }
  private paths() {
    const directory = this.options.directory ?? resolveDataDir();
    return { directory, profiles: join(directory, 'profiles'), profile: join(directory, 'profiles/default'), state: join(directory, 'browser.json') };
  }
  private read(): BrowserProcess | undefined {
    const path = this.paths().state;
    try { return processSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw unavailable(); }
  }
  current(): BrowserState | undefined {
    const state = this.currentProcess();
    return state?.endpoint ? stateSchema.parse(state) : undefined;
  }
  /** Includes a launched process whose debugging endpoint is not ready yet. */
  currentProcess(): BrowserProcess | undefined {
    const state = this.read();
    if (!state || this.alive(state.pid)) return state;
    const paths = this.paths();
    try {
      // Re-read identity before cleanup; an observer must never remove a replacement resident.
      const identity = statSync(paths.state);
      const latest = this.read();
      if (latest?.pid !== state.pid) return latest && this.alive(latest.pid) ? latest : undefined;
      if (!this.alive(state.pid)) {
        const current = statSync(paths.state);
        if (identity.ino === current.ino && identity.dev === current.dev && this.read()?.pid === state.pid) {
          unlinkSync(paths.state); releaseProfileLock(state.pid, paths.profiles);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      releaseProfileLock(state.pid, paths.profiles);
    }
    return undefined;
  }
  private publish(state: BrowserProcess): void {
    const paths = this.paths();
    const temporary = join(paths.directory, `browser.json.${state.pid}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
      chmodSync(temporary, 0o600); renameSync(temporary, paths.state);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private choose(profile: string, bundled: string): Promise<CaptureBrowser> {
    return chooseBrowser({ profile, override: this.options.override ?? process.env.COURSEWORK_BROWSER,
      isInstalled: this.options.isInstalled ?? (choice => isBrowserInstalled(choice, bundled)),
      isTTY: this.options.isTTY ?? false, confirm: this.options.confirm ?? (async () => false) });
  }
  async start(): Promise<BrowserState> {
    const existing = this.current();
    if (existing) {
      // An explicit override is still validated when reusing a running resident.
      if (this.options.override !== undefined || process.env.COURSEWORK_BROWSER !== undefined) {
        await this.choose(this.paths().profile, chromium.executablePath());
      }
      return existing;
    }
    const paths = this.paths(); mkdirSync(paths.profiles, { recursive: true, mode: 0o700 });
    const lock = acquireProfileLock({ directory: paths.profiles, pid: this.options.ownerPid, isAlive: this.alive, now: () => this.clock.now() });
    let pid: number | undefined;
    try {
      if (existsSync(paths.state)) unlinkSync(paths.state);
      const bundled = chromium.executablePath();
      const browser = await this.choose(paths.profile, bundled);
      const executable = this.options.executable?.(browser) ?? (browser === 'chromium' ? bundled
        : browserExecutablePaths(browser, process.platform, process.env).find(path => existsSync(path)));
      if (!executable) throw unavailable();
      mkdirSync(paths.profile, { recursive: true, mode: 0o700 });
      // Record the choice before launching so a failed start does not leave an unknown profile.
      recordBrowser(paths.profile, browser);
      const portFile = join(paths.profile, 'DevToolsActivePort');
      if (existsSync(portFile)) unlinkSync(portFile);
      pid = await (this.options.launch ?? launch)(executable, [
        `--user-data-dir=${paths.profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--no-first-run', '--no-default-browser-check', 'about:blank',
      ]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw unavailable();
      lock.transfer(pid);
      const processState = { pid, browser, startedAt: new Date(this.clock.now()).toISOString() };
      this.publish(processState);
      await (this.options.watchExit ?? watchExit)(processState, paths.directory);
      const deadline = this.clock.now() + (this.options.timeoutMs ?? 10000);
      let port: number | undefined;
      while (this.alive(pid)) {
        if (existsSync(portFile)) {
          const line = readFileSync(portFile, 'utf8').split('\n')[0];
          if (line && /^[1-9]\d{0,4}$/.test(line) && Number(line) <= 65535) { port = Number(line); break; }
        }
        if (this.clock.now() >= deadline) break;
        await this.clock.sleep(50);
      }
      if (!port) throw unavailable();
      const state = { ...processState, endpoint: `http://127.0.0.1:${port}` };
      this.publish(state);
      return state;
    } catch (error) {
      if (pid && this.alive(pid)) {
        try { await this.terminate(pid); } catch {
          // Leave a record for `stop` if possible; otherwise the owner closes the window and the lock goes stale.
          if (this.read()?.pid !== pid) {
            try { this.publish({ pid, browser: this.read()?.browser ?? 'msedge', startedAt: new Date(this.clock.now()).toISOString() }); }
            catch { /* the error below tells the owner which process to close */ }
          }
          throw new CourseworkError('LOCKED', `Resident browser (process ${pid}) could not be stopped; close its window, then retry.`);
        }
      }
      if (pid && this.read()?.pid === pid && existsSync(paths.state)) unlinkSync(paths.state);
      lock(); throw error;
    }
  }
  private async terminate(pid: number): Promise<void> {
    await (this.options.terminate ?? (async processId => { process.kill(processId, 'SIGTERM'); }))(pid);
    const deadline = this.clock.now() + (this.options.timeoutMs ?? 10000);
    while (this.alive(pid)) {
      if (this.clock.now() >= deadline) throw new CourseworkError('LOCKED', 'Resident browser still owns the profile.');
      await this.clock.sleep(50);
    }
  }
  async stop(): Promise<void> {
    const state = this.read(); if (!state) return;
    const paths = this.paths();
    const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
    let identity: ReturnType<typeof statSync> | undefined;
    try { identity = statSync(paths.state); } catch (error) { if (!gone(error)) throw error; }
    if (this.alive(state.pid)) await this.terminate(state.pid);
    // A concurrent start may have replaced the dead resident; preserve its state and lock.
    // ENOENT means the exit observer already removed the state.
    if (identity) {
      try {
        const current = statSync(paths.state);
        if (identity.ino !== current.ino || identity.dev !== current.dev) return;
        unlinkSync(paths.state);
      } catch (error) { if (!gone(error)) throw error; }
    }
    releaseProfileLock(state.pid, paths.profiles);
  }
}
