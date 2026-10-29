// AppleScript browser bridge for macOS (openspec change generic-adapters, design §6, decision #445). The scripts are
// the ones the Canvas and Handbook collectors ran before the move, with the application name taken from a fixed map
// (never from settings text). `runOsascript` is injectable so tests never drive a real browser.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertAllowedUrl, assertReadKind, markedUrl, READ_EXPRESSIONS, TabUnrecognisedError } from './bridge.mjs';

/** Bridge id → application name. The only place an application name comes from. */
export const APPLESCRIPT_APPS = Object.freeze({ 'edge-applescript': 'Microsoft Edge' });

const exec = promisify(execFile);
/** Runs one AppleScript with arguments through `/usr/bin/osascript` and returns its trimmed output. */
export async function runOsascript(script, args) {
  return (await exec('/usr/bin/osascript', ['-e', script, ...args], { timeout: 15000, maxBuffer: 24 * 1024 * 1024 })).stdout.trim();
}

const tell = (app, body) => `on run argv
 tell application "${app}"
${body}
 end tell
end run`;
const findTab = ` set w to first window whose id is (item 1 of argv as integer)
  set t to first tab of w whose id is (item 2 of argv)`;
const checkedTab = `${findTab}
  if URL of t does not start with (item 3 of argv) then error "UNEXPECTED_URL"
  if loading of t then error "PAGE_STILL_LOADING"`;

/** The AppleScripts of a bridge, byte for byte those of the collectors before the move (with `app` substituted). */
export function appleScripts(app) {
  return {
    create: tell(app, `  if (count of windows) is 0 then error "EDGE_WINDOW_MISSING"
  set w to front window
  set previousTab to active tab of w
  set previousIndex to active tab index of w
  set previousId to id of previousTab
  set targetTab to make new tab at end of tabs of w with properties {URL:item 1 of argv}
  set targetId to id of targetTab
  if id of active tab of w is targetId then set active tab index of w to previousIndex
  return (id of w as text) & ":" & targetId`),
    status: tell(app, ` ${findTab}
  if URL of t does not start with (item 3 of argv) then return "redirect"
  if loading of t then return "loading"
  return "ready"`),
    // The same-origin JSON expression is passed as argument 4 (as the Canvas collector did).
    'same-origin-json': tell(app, ` ${checkedTab}
  return execute t javascript (item 4 of argv)`),
    'body-text': tell(app, ` ${checkedTab}
  return execute t javascript ${JSON.stringify(READ_EXPRESSIONS['body-text'])}`),
    'navigation-status': tell(app, ` ${findTab}
  return execute t javascript ${JSON.stringify(READ_EXPRESSIONS['navigation-status'])}`),
    close: tell(app, ` ${findTab}
  close t`),
  };
}

/**
 * An AppleScript bridge. `allowedOrigins` are the origins `open` accepts; `runner(script, args)` defaults to
 * `/usr/bin/osascript`; `platform` defaults to the process's. Unavailable off macOS.
 */
export function createAppleScriptBridge({ id, allowedOrigins, runner = runOsascript, platform = process.platform }) {
  const app = Object.hasOwn(APPLESCRIPT_APPS, id) ? APPLESCRIPT_APPS[id] : null;
  if (!app) throw new Error(`未知的浏览器桥：${String(id)}`);
  if (platform !== 'darwin') throw new Error(`${app} 的 AppleScript 采集只能在 macOS 上使用`);
  const origins = [...allowedOrigins];
  const scripts = appleScripts(app);
  return {
    id,
    async open(url, _expectedPrefix) {
      assertAllowedUrl(url, origins);
      const identity = (await runner(scripts.create, [markedUrl(url)])).split(':');
      if (identity.length !== 2 || !/^\d+$/.test(identity[0]) || !identity[1]) throw new TabUnrecognisedError();
      return identity;
    },
    state: async (tab, expectedPrefix) => runner(scripts.status, [...tab, expectedPrefix]),
    async read(tab, expectedPrefix, kind) {
      assertReadKind(kind);
      if (kind === 'same-origin-json') return runner(scripts[kind], [...tab, expectedPrefix, READ_EXPRESSIONS[kind]]);
      if (kind === 'body-text') return runner(scripts[kind], [...tab, expectedPrefix]);
      return runner(scripts[kind], [...tab]);
    },
    async close(tab) { await runner(scripts.close, [...tab]); },
    async dispose() {},
  };
}
