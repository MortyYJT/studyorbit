import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { chooseBrowser, recordBrowser, BrowserChoiceError, browserExecutablePaths } from '../../src/capture/browser.js';

const roots: string[] = [];
function profile(record?: string) {
  const root = mkdtempSync(join(tmpdir(), 'coursework-browser-')); roots.push(root);
  const path = join(root, 'default');
  if (record !== undefined) { mkdirSync(path); if (record) writeFileSync(join(path, 'coursework-browser.json'), JSON.stringify({ browser: record })); }
  return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function options(path = profile(), installed: string[] = ['msedge', 'chrome']) {
  return { profile: path, isInstalled: vi.fn((browser: string) => installed.includes(browser)), isTTY: true, confirm: vi.fn(async () => true) };
}
it('prefers Edge and records it only after a successful launch', async () => {
  const opts = options();
  expect(await chooseBrowser(opts)).toBe('msedge');
  expect(existsSync(opts.profile)).toBe(false);
  recordBrowser(opts.profile, 'msedge');
  expect(JSON.parse(readFileSync(join(opts.profile, 'coursework-browser.json'), 'utf8'))).toEqual({ browser: 'msedge' });
});
it('uses Chrome when Edge is absent', async () => { expect(await chooseBrowser(options(profile(), ['chrome']))).toBe('chrome'); });
it('refuses a different browser and names both and recovery', async () => {
  await expect(chooseBrowser(options(profile('chrome')))).rejects.toThrow(/chrome.*msedge.*COURSEWORK_BROWSER.*remove.*profile/i);
});
it('override reuses a recorded Chrome profile even with Edge installed', async () => {
  expect(await chooseBrowser({ ...options(profile('chrome')), override: 'chrome' })).toBe('chrome');
});
it('unknown legacy profile needs an explicit override before any prompt', async () => {
  const opts = options(profile(''), []);
  await expect(chooseBrowser(opts)).rejects.toThrow(/COURSEWORK_BROWSER.*remove.*profile/i);
  expect(opts.confirm).not.toHaveBeenCalled();
  expect(await chooseBrowser({ ...opts, override: 'chromium', isInstalled: () => true })).toBe('chromium');
});
it.each(['bad', '', 'Chrome'])('invalid override %j exits 2 and lists all values', async override => {
  const opts = options();
  await expect(chooseBrowser({ ...opts, override })).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/msedge.*chrome.*chromium/) });
  expect(opts.isInstalled).not.toHaveBeenCalled();
});
it.each(['msedge', 'chrome', 'chromium'])('missing override %s never falls back', async override => {
  const opts = options(profile(), []);
  await expect(chooseBrowser({ ...opts, override })).rejects.toThrow(/not installed/i);
  expect(opts.confirm).not.toHaveBeenCalled();
});
it('asks before bundled Chromium; refusal exits 1 without a profile record', async () => {
  const opts = options(profile(), ['chromium']);
  expect(await chooseBrowser(opts)).toBe('chromium'); expect(opts.confirm).toHaveBeenCalledOnce();
  opts.confirm.mockResolvedValue(false);
  await expect(chooseBrowser(opts)).rejects.toBeInstanceOf(BrowserChoiceError);
  await expect(chooseBrowser(opts)).rejects.toMatchObject({ exitCode: 1 });
  expect(existsSync(opts.profile)).toBe(false);
});
it('no TTY or absent bundled build errors without downloading or asking', async () => {
  for (const opts of [{ ...options(profile(), ['chromium']), isTTY: false }, options(profile(), [])]) {
    await expect(chooseBrowser(opts)).rejects.toThrow(); expect(opts.confirm).not.toHaveBeenCalled();
  }
});
it('invalid record fails closed', async () => { await expect(chooseBrowser(options(profile('other')))).rejects.toThrow(/record/i); });
it('standard executable paths cover macOS, Linux and Windows', () => {
  expect(browserExecutablePaths('msedge', 'darwin', {})).toEqual(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
  expect(browserExecutablePaths('chrome', 'linux', {})).toEqual(['/opt/google/chrome/chrome']);
  expect(browserExecutablePaths('msedge', 'win32', { LOCALAPPDATA: 'C:\\Local', PROGRAMFILES: 'C:\\Programs', 'PROGRAMFILES(X86)': 'C:\\Programs86' })).toHaveLength(3);
  expect(browserExecutablePaths('chrome', 'freebsd', {})).toEqual([]);
});
