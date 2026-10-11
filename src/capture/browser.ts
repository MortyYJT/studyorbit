import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

export type CaptureBrowser = 'msedge' | 'chrome' | 'chromium';
export class BrowserChoiceError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}
const browsers: CaptureBrowser[] = ['msedge', 'chrome', 'chromium'];
export function browserExecutablePaths(browser: Exclude<CaptureBrowser, 'chromium'>, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return [browser === 'msedge'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (platform === 'linux') return [browser === 'msedge' ? '/opt/microsoft/msedge/msedge' : '/opt/google/chrome/chrome'];
  if (platform === 'win32') {
    const suffix = browser === 'msedge' ? ['Microsoft', 'Edge', 'Application', 'msedge.exe'] : ['Google', 'Chrome', 'Application', 'chrome.exe'];
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]
      .filter((root): root is string => Boolean(root)).map(root => win32.join(root, ...suffix));
  }
  return [];
}
export function isBrowserInstalled(browser: CaptureBrowser, bundledPath: string): boolean {
  return browser === 'chromium' ? existsSync(bundledPath)
    : browserExecutablePaths(browser, process.platform, process.env).some(path => existsSync(path));
}
export async function chooseBrowser(options: {
  profile: string; override?: string; isInstalled: (browser: CaptureBrowser) => boolean;
  isTTY: boolean; confirm: () => Promise<boolean>;
}): Promise<CaptureBrowser> {
  const { profile, override, isInstalled } = options;
  if (override !== undefined && !browsers.includes(override as CaptureBrowser)) {
    throw new BrowserChoiceError('COURSEWORK_BROWSER must be one of: msedge, chrome, chromium.', 2);
  }
  const record = join(profile, 'coursework-browser.json');
  let recorded: CaptureBrowser | undefined;
  if (existsSync(record)) {
    try {
      const value: unknown = JSON.parse(readFileSync(record, 'utf8'));
      const browser = (value as { browser?: unknown } | null)?.browser;
      if (!browsers.includes(browser as CaptureBrowser)) throw new Error();
      recorded = browser as CaptureBrowser;
    } catch { throw new BrowserChoiceError('Invalid browser record. Remove the profile and sign in again.'); }
  } else if (existsSync(profile) && override === undefined) {
    throw new BrowserChoiceError('Profile browser is unknown. Set COURSEWORK_BROWSER to its browser or remove the profile and sign in again.');
  }
  let selected: CaptureBrowser;
  if (override !== undefined) {
    selected = override as CaptureBrowser;
    if (!isInstalled(selected)) throw new BrowserChoiceError(`${selected} is not installed. No fallback will be launched.`);
  } else if (isInstalled('msedge')) selected = 'msedge';
  else if (isInstalled('chrome')) selected = 'chrome';
  else {
    if (recorded && recorded !== 'chromium') {
      throw mismatch(recorded, 'chromium');
    }
    if (!options.isTTY) throw new BrowserChoiceError('No Edge or Chrome installed. Run capture in a terminal to choose bundled Chromium.');
    if (!isInstalled('chromium')) throw new BrowserChoiceError('Bundled Chromium is not installed. No browser will be downloaded.');
    if (!await options.confirm()) throw new BrowserChoiceError('Bundled Chromium declined.', 1);
    selected = 'chromium';
  }
  if (recorded && recorded !== selected) throw mismatch(recorded, selected);
  return selected;
}
function mismatch(recorded: CaptureBrowser, selected: CaptureBrowser): BrowserChoiceError {
  return new BrowserChoiceError(`Profile records ${recorded}, but detection selected ${selected}. Set COURSEWORK_BROWSER=${recorded} or remove the profile and sign in again.`);
}
export function recordBrowser(profile: string, browser: CaptureBrowser): void {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'coursework-browser.json'), JSON.stringify({ browser }) + '\n', { mode: 0o600 });
}
