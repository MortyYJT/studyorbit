import { mkdtempSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ResidentBrowser } from '../../src/browser/resident.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'resident-synthetic-')); roots.push(root);
  let now = 0; const alive = new Set<number>();
  const clock = { now: () => now, sleep: vi.fn(async (ms: number) => { now += ms; }) };
  const launch = vi.fn(async (_executable: string, args: string[]) => {
    const profile = args.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
    writeFileSync(join(profile, 'DevToolsActivePort'), '43210\n/devtools/browser/synthetic\n');
    alive.add(12345); return 12345;
  });
  const terminate = vi.fn(async (pid: number) => { alive.delete(pid); });
  const options = { directory: root, clock, launch, terminate, watchExit: vi.fn(async () => {}), isAlive: (pid: number) => alive.has(pid),
    executable: () => '/synthetic/edge', isInstalled: (browser: string) => browser !== 'chromium',
    isTTY: false, confirm: vi.fn(async () => false), ownerPid: 99999 };
  return { root, alive, clock, launch, terminate, options, resident: new ResidentBrowser(options) };
}
it('3.1 launches once on loopback, persists private state and a browser-owned lock across instances, stops cleanly', async () => {
  const s = setup();
  const first = await s.resident.start();
  expect(first).toEqual({ endpoint: 'http://127.0.0.1:43210', pid: 12345, browser: 'msedge', startedAt: '1970-01-01T00:00:00.000Z' });
  expect(s.launch).toHaveBeenCalledOnce();
  const args = s.launch.mock.calls[0]![1];
  expect(args).toContain('--remote-debugging-address=127.0.0.1');
  expect(args).toContain('--remote-debugging-port=0');
  expect(args).toContain(`--user-data-dir=${join(s.root, 'profiles/default')}`);
  const state = join(s.root, 'browser.json');
  expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual(first);
  expect(statSync(state).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(s.root, 'profiles/default.lock'), 'utf8')).toBe('12345');
  expect(await new ResidentBrowser(s.options).start()).toEqual(first);
  expect(s.launch).toHaveBeenCalledOnce();
  await new ResidentBrowser(s.options).stop();
  expect(s.terminate).toHaveBeenCalledExactlyOnceWith(12345);
  expect(existsSync(state)).toBe(false);
  expect(existsSync(join(s.root, 'profiles/default.lock'))).toBe(false);
  await s.resident.stop();
  expect(s.terminate).toHaveBeenCalledOnce();
});
it('3.1 clears a dead resident and lock, ignores old DevToolsActivePort and starts afresh', async () => {
  const s = setup(); await s.resident.start(); s.alive.clear();
  writeFileSync(join(s.root, 'profiles/default/DevToolsActivePort'), '1234\nstale');
  expect((await new ResidentBrowser(s.options).start()).endpoint).toBe('http://127.0.0.1:43210');
  expect(s.launch).toHaveBeenCalledTimes(2);
});
it('3.1 refuses a live foreign profile lock and browser mismatch without launching', async () => {
  const s = setup(); mkdirSync(join(s.root, 'profiles'), { recursive: true });
  writeFileSync(join(s.root, 'profiles/default.lock'), '888'); s.alive.add(888);
  await expect(s.resident.start()).rejects.toMatchObject({ code: 'LOCKED' }); expect(s.launch).not.toHaveBeenCalled();
  s.alive.clear(); mkdirSync(join(s.root, 'profiles/default'));
  writeFileSync(join(s.root, 'profiles/default/coursework-browser.json'), '{"browser":"chrome"}');
  await expect(s.resident.start()).rejects.toThrow(/chrome.*msedge.*COURSEWORK_BROWSER/);
  expect(s.launch).not.toHaveBeenCalled();
});
it('3.1 honours override, refuses unknown profiles and invalid overrides before launch', async () => {
  for (const override of ['invalid', undefined]) {
    const s = setup(); mkdirSync(join(s.root, 'profiles/default'), { recursive: true });
    await expect(new ResidentBrowser({ ...s.options, override }).start()).rejects.toThrow();
    expect(s.launch).not.toHaveBeenCalled();
  }
  const s = setup();
  expect((await new ResidentBrowser({ ...s.options, override: 'chrome' }).start()).browser).toBe('chrome');
});
it('3.1 timeout terminates child and releases state/lock; failed stop retains live ownership', async () => {
  const s = setup();
  s.launch.mockImplementation(async () => { s.alive.add(12345); return 12345; });
  await expect(new ResidentBrowser({ ...s.options, timeoutMs: 200 }).start()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  expect(s.terminate).toHaveBeenCalledExactlyOnceWith(12345);
  expect(existsSync(join(s.root, 'browser.json'))).toBe(false);
  expect(existsSync(join(s.root, 'profiles/default.lock'))).toBe(false);
  const t = setup(); await t.resident.start();
  await expect(new ResidentBrowser({ ...t.options, terminate: async () => {}, timeoutMs: 200 }).stop()).rejects.toMatchObject({ code: 'LOCKED' });
  expect(existsSync(join(t.root, 'browser.json'))).toBe(true);
  expect(readFileSync(join(t.root, 'profiles/default.lock'), 'utf8')).toBe('12345');
});
it('3.1 observes normal browser exit and removes only its dead state and lock', async () => {
  const s = setup(); const state = await s.resident.start();
  s.alive.delete(state.pid);
  expect(s.resident.current()).toBeUndefined();
  expect(existsSync(join(s.root, 'browser.json'))).toBe(false);
  expect(existsSync(join(s.root, 'profiles/default.lock'))).toBe(false);
});
it('3.1 injected exit observer runs after publication, cleans normal exit and stops if replaced', async () => {
  const { watchBrowserExit } = await import('../../src/browser/watch.js');
  const s = setup(); const state = await s.resident.start();
  expect(s.options.watchExit).toHaveBeenCalledExactlyOnceWith(state, s.root);
  const sleep = vi.fn(async () => { s.alive.clear(); });
  await watchBrowserExit(s.resident, state.pid, { now: () => 0, sleep });
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
  expect(existsSync(join(s.root, 'browser.json'))).toBe(false);
  const replacement = { current: () => ({ ...state, pid: 56789 }) };
  await watchBrowserExit(replacement, state.pid, { now: () => 0, sleep });
  expect(sleep).toHaveBeenCalledOnce();
});
it('3.1 a live resident still rejects an invalid override and a changed detected browser', async () => {
  const s = setup(); await s.resident.start();
  await expect(new ResidentBrowser({ ...s.options, override: 'invalid' }).start()).rejects.toMatchObject({ exitCode: 2 });
  await expect(new ResidentBrowser({ ...s.options, override: 'chrome' }).start()).rejects.toThrow(/msedge.*chrome.*COURSEWORK_BROWSER/);
  expect(s.launch).toHaveBeenCalledOnce();
});
