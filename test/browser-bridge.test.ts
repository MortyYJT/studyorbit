import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPLESCRIPT_APPS, appleScripts, createAppleScriptBridge } from '../scripts/browser/applescript.mjs';
import {
  assertAllowedUrl, LOAD_LIMIT_MS, POLL_MS, READ_EXPRESSIONS, READ_RETRY_MS, TabUnrecognisedError, withPage, type BrowserBridge, type ReadKind,
} from '../scripts/browser/bridge.mjs';

// The browser bridge (openspec change generic-adapters, design §5–§6, decisions #444, #445): the shared page loop
// with a fake bridge and a virtual clock, and the AppleScript bridge with a fake osascript runner. Never a real browser.

type Step = string | Error;
/** A fake bridge: `states` and `reads` are answered in order (the last repeats); every call is logged. */
function fakeBridge({ states = ['ready'] as Step[], reads = ['text'] as Step[], open = ['1', 't'] as string[] | Error, close = null as Error | null } = {}) {
  const calls: string[] = [];
  let stateIndex = 0, readIndex = 0;
  const next = (list: Step[], index: number) => list[Math.min(index, list.length - 1)]!;
  const bridge: BrowserBridge = {
    id: 'fake',
    async open(url) { calls.push(`open ${url}`); if (open instanceof Error) throw open; return open; },
    async state() { const step = next(states, stateIndex++); calls.push(`state ${String(step)}`); if (step instanceof Error) throw step; return step; },
    async read(_tab, _prefix, kind: ReadKind) { const step = next(reads, readIndex++); calls.push(`read ${kind}`); if (step instanceof Error) throw step; return step; },
    async close() { calls.push('close'); if (close) throw close; },
    async dispose() { calls.push('dispose'); },
  };
  return { bridge, calls };
}
/** A virtual clock whose sleeps advance time at once. */
function virtualTime() {
  let now = 0;
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; }, sleeps };
}
const messages = { identity: 'IDENTITY', redirect: 'REDIRECT', timeout: 'TIMEOUT' };
const accept = (text: string) => { if (text !== 'good') throw new Error(`bad ${text}`); return text.toUpperCase(); };

describe('withPage', () => {
  it('polls every 250 ms until ready, reads once and closes', async () => {
    const { bridge, calls } = fakeBridge({ states: ['loading', 'loading', 'ready'], reads: ['good'] });
    const time = virtualTime();
    await expect(withPage(bridge, 'https://x.example.edu/a', 'https://x.example.edu/a', 'body-text', { accept, messages, ...time })).resolves.toBe('GOOD');
    expect(calls).toEqual(['open https://x.example.edu/a', 'state loading', 'state loading', 'state ready', 'read body-text', 'close']);
    expect(time.sleeps).toEqual([POLL_MS, POLL_MS]);
  });

  it('gives up after 20 s of loading with the timeout message and closes the tab', async () => {
    const { bridge, calls } = fakeBridge({ states: ['loading'] });
    const time = virtualTime();
    await expect(withPage(bridge, 'u', 'p', 'body-text', { accept, messages, ...time })).rejects.toThrow('TIMEOUT');
    expect(time.now()).toBe(LOAD_LIMIT_MS);
    expect(calls.at(-1)).toBe('close');
    expect(calls).not.toContain('read body-text');
  });

  it('reads nothing after a redirect and closes the tab', async () => {
    const { bridge, calls } = fakeBridge({ states: ['redirect'] });
    await expect(withPage(bridge, 'u', 'p', 'same-origin-json', { accept, messages, ...virtualTime() })).rejects.toThrow('REDIRECT');
    expect(calls).toEqual(['open u', 'state redirect', 'close']);
  });

  it('tries a rejected read once more after 500 ms, then reports onUnread with the tab open and keeps the last error', async () => {
    const { bridge, calls } = fakeBridge({ reads: ['bad1', 'bad2'] });
    const time = virtualTime();
    const unread: unknown[] = [];
    await expect(withPage(bridge, 'u', 'p', 'body-text', { accept, messages, ...time, onUnread: (_tab, error) => { unread.push(String(error)); calls.push('unread'); } }))
      .rejects.toThrow('bad bad2');
    expect(calls).toEqual(['open u', 'state ready', 'read body-text', 'read body-text', 'unread', 'close']);
    expect(time.sleeps).toEqual([READ_RETRY_MS]);
    expect(unread).toEqual(['Error: bad bad2']);
  });

  it('lets onUnread replace the error, and succeeds on the second read', async () => {
    const replaced = fakeBridge({ reads: ['bad'] });
    await expect(withPage(replaced.bridge, 'u', 'p', 'body-text', { accept, messages, ...virtualTime(), onUnread: () => { throw new Error('HTTP 503'); } })).rejects.toThrow('HTTP 503');
    const second = fakeBridge({ reads: [new Error('osascript failed'), 'good'] });
    await expect(withPage(second.bridge, 'u', 'p', 'body-text', { accept, messages, ...virtualTime() })).resolves.toBe('GOOD');
  });

  it('stops when aborted: no read, 已中止, tab closed', async () => {
    const { bridge, calls } = fakeBridge({ states: ['loading'] });
    let aborted = false;
    const time = virtualTime();
    const sleep = async (ms: number) => { await time.sleep(ms); aborted = true; };
    await expect(withPage(bridge, 'u', 'p', 'body-text', { accept, messages, now: time.now, sleep, isAborted: () => aborted })).rejects.toThrow('已中止');
    expect(calls).toEqual(['open u', 'state loading', 'close']);
  });

  it('maps an unrecognised tab to the collector message without closing; reports a failed close after an error', async () => {
    const unrecognised = fakeBridge({ open: new TabUnrecognisedError() });
    await expect(withPage(unrecognised.bridge, 'u', 'p', 'body-text', { accept, messages })).rejects.toThrow('IDENTITY');
    expect(unrecognised.calls).toEqual(['open u']);
    const closing = fakeBridge({ states: ['redirect'], close: new Error('gone') });
    let reported = 0;
    await expect(withPage(closing.bridge, 'u', 'p', 'body-text', { accept, messages, onCloseError: () => { reported++; } })).rejects.toThrow('REDIRECT');
    expect(reported).toBe(1);
    const closingAfterRead = fakeBridge({ reads: ['good'], close: new Error('gone') });
    await expect(withPage(closingAfterRead.bridge, 'u', 'p', 'body-text', { accept, messages })).rejects.toThrow('gone');
  });

  it('refuses an unknown read kind before opening anything', async () => {
    const { bridge, calls } = fakeBridge();
    await expect(withPage(bridge, 'u', 'p', 'run-this' as ReadKind, { accept, messages })).rejects.toThrow('未知的读取方式');
    expect(calls).toEqual([]);
  });
});

describe('AppleScript bridge (Edge)', () => {
  const goldenScripts = async (name: string) => JSON.parse(await readFile(join(import.meta.dirname, 'golden', name), 'utf8')).scripts as string[];
  const recorder = (answers: Record<string, string> = {}) => {
    const calls: { script: string; args: string[] }[] = [];
    const runner = async (script: string, args: string[]) => {
      calls.push({ script, args });
      if (script.includes('make new tab')) return answers.create ?? '7:tab-1';
      return answers.other ?? 'ready';
    };
    return { calls, runner };
  };
  const origins = ['https://canvas.example.edu', 'https://handbook.example.edu'];

  it('generates the scripts the collectors ran before the move', async () => {
    const scripts = appleScripts('Microsoft Edge');
    expect(await goldenScripts('canvas-discover-calls.json')).toEqual([scripts.create, scripts.status, scripts['same-origin-json'], scripts.close]);
    expect(await goldenScripts('handbook-calls.json')).toEqual([scripts.create, scripts.status, scripts['body-text'], scripts.close]);
    expect(scripts['navigation-status']).toContain(`execute t javascript ${JSON.stringify(READ_EXPRESSIONS['navigation-status'])}`);
    expect(Object.values(scripts).every(script => script.includes('tell application "Microsoft Edge"'))).toBe(true);
    expect(APPLESCRIPT_APPS).toEqual({ 'edge-applescript': 'Microsoft Edge' });
  });

  it('opens a marked background tab, and maps each read kind to its constant expression only', async () => {
    const { calls, runner } = recorder({ other: 'text' });
    const bridge = createAppleScriptBridge({ id: 'edge-applescript', allowedOrigins: origins, runner, platform: 'darwin' });
    const tab = await bridge.open('https://canvas.example.edu/api/v1/courses?x=1', 'https://canvas.example.edu/api/v1/courses');
    expect(tab).toEqual(['7', 'tab-1']);
    expect(calls[0]!.args[0]).toMatch(/^https:\/\/canvas\.example\.edu\/api\/v1\/courses\?x=1#coursework-[0-9a-f-]{36}$/);
    await bridge.read(tab, 'P', 'same-origin-json');
    await bridge.read(tab, 'P', 'body-text');
    await bridge.read(tab, 'P', 'navigation-status');
    expect(calls.slice(1).map(call => call.args)).toEqual([['7', 'tab-1', 'P', READ_EXPRESSIONS['same-origin-json']], ['7', 'tab-1', 'P'], ['7', 'tab-1']]);
    await expect(bridge.read(tab, 'P', 'document.cookie' as ReadKind)).rejects.toThrow('未知的读取方式');
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.script).not.toMatch(/cookie|localStorage|sessionStorage/i);
  });

  it('refuses a URL outside the allowed origins before any osascript call', async () => {
    const { calls, runner } = recorder();
    const bridge = createAppleScriptBridge({ id: 'edge-applescript', allowedOrigins: ['https://canvas.example.edu'], runner, platform: 'darwin' });
    for (const url of ['https://example.org/', 'http://canvas.example.edu/api', 'https://canvas.example.edu.evil.example/x', 'javascript:alert(1)', 'not a url']) {
      await expect(bridge.open(url, url)).rejects.toThrow(/浏览器桥拒绝/);
    }
    expect(calls).toEqual([]);
    expect(() => assertAllowedUrl('https://canvas.example.edu/x', ['https://canvas.example.edu'])).not.toThrow();
  });

  it('rejects an unrecognised tab identity, unknown bridges and other platforms', async () => {
    const { runner } = recorder({ create: 'garbage' });
    const bridge = createAppleScriptBridge({ id: 'edge-applescript', allowedOrigins: origins, runner, platform: 'darwin' });
    await expect(bridge.open('https://canvas.example.edu/a', 'x')).rejects.toBeInstanceOf(TabUnrecognisedError);
    expect(() => createAppleScriptBridge({ id: 'safari-applescript', allowedOrigins: origins, runner, platform: 'darwin' })).toThrow('未知的浏览器桥');
    expect(() => createAppleScriptBridge({ id: 'edge-applescript', allowedOrigins: origins, runner, platform: 'linux' })).toThrow('只能在 macOS 上使用');
  });
});
