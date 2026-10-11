import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { capture } from '../../src/capture/command.js';
import { chromium } from 'playwright';
import { isBrowserInstalled } from '../../src/capture/browser.js';
import { openHiddenPage } from '../../src/capture/tab.js';
import { saveSnapshot } from '../../src/capture/snapshot.js';

vi.mock('../../src/capture/tab.js', () => ({ openHiddenPage: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { executablePath: () => '/synthetic/bundled', launchPersistentContext: vi.fn() } }));
vi.mock('../../src/capture/browser.js', async original => ({ ...await original<object>(), isBrowserInstalled: vi.fn(() => true) }));
vi.mock('../../src/capture/snapshot.js', async original => ({ ...await original<object>(), saveSnapshot: vi.fn(async () => '/synthetic/snapshot') }));
vi.mock('node:readline/promises', async original => ({ ...await original<object>(), createInterface: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'coursework-command-')); vi.stubEnv('COURSEWORK_HOME', home); vi.stubEnv('COURSEWORK_BROWSER', undefined);
  const input = new PassThrough(); const output = new PassThrough();
  // Use the real readline iterator so close and signal delivery exercise the wiring.
  const original = vi.importActual<typeof import('node:readline/promises')>('node:readline/promises');
  const active = { isClosed: () => false, evaluate: async () => true, url: () => 'https://canvas.lms.unimelb.edu.au/courses/91001' };
  const context = Object.assign(new EventEmitter(), { pages: () => [active], close: vi.fn(async () => { context.emit('close'); }), newPage: vi.fn() });
  vi.mocked(chromium.launchPersistentContext).mockResolvedValue(context as never);
  vi.mocked(isBrowserInstalled).mockReturnValue(true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  cleanups.push(() => { input.destroy(); output.destroy(); rmSync(home, { recursive: true, force: true }); });
  return { home, input, output, original, active, context, log };
}
async function terminal(f: ReturnType<typeof setup>) {
  const rl = (await f.original).createInterface({ input: f.input, output: f.output }); vi.mocked(createInterface).mockReturnValue(rl); return rl;
}
it('launches detected Edge headed, records it, lists commands and releases the lock on q', async () => {
  const f = setup(); await terminal(f); const running = capture();
  await vi.waitFor(() => expect(f.log).toHaveBeenCalled()); f.input.write('q\n'); await running;
  expect(chromium.launchPersistentContext).toHaveBeenCalledWith(join(f.home, 'profiles/default'), { headless: false, handleSIGINT: false, handleSIGTERM: false, channel: 'msedge' });
  expect(JSON.parse(readFileSync(join(f.home, 'profiles/default/coursework-browser.json'), 'utf8'))).toEqual({ browser: 'msedge' });
  expect(f.log.mock.calls[0][0]).toMatch(/s.*c.*q/); expect(existsSync(join(f.home, 'profiles/default.lock'))).toBe(false);
});
it('invalid override refuses launch and releases lock', async () => {
  const f = setup(); await terminal(f); vi.stubEnv('COURSEWORK_BROWSER', 'invalid');
  await expect(capture()).rejects.toMatchObject({ exitCode: 2 }); expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  expect(existsSync(join(f.home, 'profiles/default.lock'))).toBe(false);
});
it('legacy profile refuses launch without override', async () => {
  const f = setup(); await terminal(f); mkdirSync(join(f.home, 'profiles/default'), { recursive: true });
  await expect(capture()).rejects.toThrow(/COURSEWORK_BROWSER/); expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
});
it('mismatch refuses launch', async () => {
  const f = setup(); await terminal(f); mkdirSync(join(f.home, 'profiles/default'), { recursive: true });
  writeFileSync(join(f.home, 'profiles/default/coursework-browser.json'), JSON.stringify({ browser: 'chrome' }));
  await expect(capture()).rejects.toThrow(/chrome.*msedge/); expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
});
it('failed launch does not record a browser', async () => {
  const f = setup(); await terminal(f); vi.mocked(chromium.launchPersistentContext).mockRejectedValueOnce(new Error('launch failure'));
  await expect(capture()).rejects.toThrow('launch failure'); expect(existsSync(join(f.home, 'profiles/default/coursework-browser.json'))).toBe(false);
});
it.each(['q', 'SIGINT', 'SIGTERM', 'browser close', 'terminal close'])('%s waits for current load, writes aborted summary and releases lock', async action => {
  const f = setup(); const rl = await terminal(f);
  let finish!: () => void;
  const page = { url: () => 'https://canvas.lms.unimelb.edu.au/courses',
    goto: vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { status: () => 200 }; }),
    waitForLoadState: vi.fn(async () => {}), evaluate: vi.fn(async () => ['/courses/91001']), close: vi.fn(async () => {}) };
  vi.mocked(openHiddenPage).mockResolvedValue(page as never);
  const running = capture(); await vi.waitFor(() => expect(f.log).toHaveBeenCalled()); f.input.write('c\n');
  await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());
  if (action === 'q') f.input.write('q\n'); else if (action === 'browser close') f.context.emit('close'); else if (action === 'terminal close') rl.close(); else process.emit(action as 'SIGINT');
  await new Promise(resolve => setImmediate(resolve)); expect(f.context.close).not.toHaveBeenCalled();
  expect(existsSync(join(f.home, 'profiles/default.lock'))).toBe(true); finish(); await running;
  expect(page.goto).toHaveBeenCalledOnce(); expect(page.close).toHaveBeenCalledOnce(); expect(saveSnapshot).toHaveBeenCalledWith(page);
  const files = readdirSync(join(f.home, 'crawls')); expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.home, 'crawls', files[0]), 'utf8'))).toMatchObject({ saved: 1, status: 'aborted' });
  expect(existsSync(join(f.home, 'profiles/default.lock'))).toBe(false);
});
it('s during crawl saves the user tab even when the background tab is the newest page', async () => {
  const f = setup(); await terminal(f); let finish!: () => void;
  const page = { isClosed: () => false, url: () => 'https://canvas.lms.unimelb.edu.au/courses',
    goto: vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { status: () => 200 }; }),
    waitForLoadState: vi.fn(async () => {}), evaluate: vi.fn(async () => []), close: vi.fn(async () => {}) };
  vi.mocked(openHiddenPage).mockResolvedValue(page as never);
  const running = capture(); await vi.waitFor(() => expect(f.log).toHaveBeenCalled()); f.input.write('c\n');
  await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());
  f.context.pages = () => [f.active, page as never]; f.input.write('c\ns\nq\n');
  await vi.waitFor(() => expect(saveSnapshot).toHaveBeenCalledWith(f.active));
  expect(f.log).toHaveBeenCalledWith('a crawl is already running'); expect(openHiddenPage).toHaveBeenCalledExactlyOnceWith(f.context, f.active);
  expect(f.context.newPage).not.toHaveBeenCalled(); finish(); await running;
});
