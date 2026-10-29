import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CDP_NEEDS_SERVER, CDP_SIGN_IN, createCdpBridge } from '../scripts/browser/cdp.mjs';
import { createCdpHost } from '../scripts/browser/cdp-host.mjs';
import { HANDBOOK_ORIGIN } from '../scripts/institutions/unimelb/handbook-source.mjs';
import { EX_SIGN_IN } from '../scripts/lib/collector-exit.mjs';
import { spawnCollector } from '../scripts/lib/sync-stages.mjs';
import { DEFAULT_SOURCE_CONFIG, sourceConfigEnv } from '../scripts/sources/config.mjs';
import { fakeCdpBrowsers } from './cdp-fakes.ts';
import { repoDir } from './collector-harness.ts';

// The collector side of the experimental CDP bridges (openspec change generic-adapters, design §7, decision #446):
// the IPC bridge with a fake channel, and real collector processes spawned by `spawnCollector` against the real host
// with a fake browser. Synthetic data only; never a real browser.

/** A fake IPC channel: `sent` collects requests, `answer` replies like the host. */
function fakeChannel() {
  const channel = Object.assign(new EventEmitter(), {
    connected: true, sent: [] as Record<string, unknown>[], disconnected: 0,
    send(message: Record<string, unknown>) { channel.sent.push(message); return true; },
    disconnect() { channel.disconnected++; channel.connected = false; channel.emit('disconnect'); },
  });
  const answer = (value: unknown, ok = true) => channel.emit('message', { id: channel.sent.at(-1)!.id, ok, ...(ok ? { value } : { error: value }) });
  return { channel, answer };
}
const ORIGIN = 'https://canvas.example.edu';

describe('the CDP bridge of a collector', () => {
  it('needs the IPC channel of the local server', () => {
    expect(() => createCdpBridge({ id: 'cdp-chrome', allowedOrigins: [ORIGIN], channel: { connected: false } as never })).toThrow(CDP_NEEDS_SERVER);
    expect(() => createCdpBridge({ id: 'edge-applescript', allowedOrigins: [ORIGIN], channel: fakeChannel().channel })).toThrow('未知的浏览器桥');
  });

  it('turns each operation into one request, marking the opened URL', async () => {
    const { channel, answer } = fakeChannel();
    const bridge = createCdpBridge({ id: 'cdp-edge', allowedOrigins: [ORIGIN], channel });
    const opened = bridge.open(`${ORIGIN}/api/v1/courses`, `${ORIGIN}/api/v1/courses`);
    answer('T7');
    expect(await opened).toEqual(['T7']);
    expect(channel.sent[0]).toMatchObject({ id: 1, op: 'open', prefix: `${ORIGIN}/api/v1/courses` });
    expect(String(channel.sent[0]!.url)).toMatch(/^https:\/\/canvas\.example\.edu\/api\/v1\/courses#coursework-[0-9a-f-]{36}$/);
    const state = bridge.state(['T7'], 'p');
    answer('ready');
    expect(await state).toBe('ready');
    const read = bridge.read(['T7'], 'p', 'body-text');
    answer('page text');
    expect(await read).toBe('page text');
    const closed = bridge.close(['T7']);
    answer(true);
    await closed;
    expect(channel.sent.map(message => message.op)).toEqual(['open', 'state', 'read', 'close']);
    expect(channel.sent[2]).toEqual({ id: 3, op: 'read', tab: 'T7', prefix: 'p', kind: 'body-text' });
    await bridge.dispose();
    expect(channel.disconnected).toBe(1);
  });

  it('refuses foreign origins and unknown read kinds without a request, and fails on errors and disconnection', async () => {
    const { channel, answer } = fakeChannel();
    const bridge = createCdpBridge({ id: 'cdp-chrome', allowedOrigins: [ORIGIN], channel, timeoutMs: 20 });
    await expect(bridge.open('https://example.org/', 'https://example.org/')).rejects.toThrow('未允许');
    await expect(bridge.read(['T1'], 'p', 'cookies' as never)).rejects.toThrow('未知的读取方式');
    expect(channel.sent).toEqual([]);
    const failing = bridge.state(['T1'], 'p');
    answer('标签页不存在或已关闭', false);
    await expect(failing).rejects.toThrow('标签页不存在或已关闭');
    await expect(bridge.state(['T1'], 'p')).rejects.toThrow('专用浏览器没有响应');
    const waiting = bridge.state(['T1'], 'p');
    channel.disconnect();
    await expect(waiting).rejects.toThrow('与本地服务的连接已断开');
    await expect(bridge.close(['T1'])).rejects.toThrow('与本地服务的连接已断开');
  });
});

// Real collector processes over IPC (`spawnCollector`) with the real host and a fake browser.
const UNIMELB = DEFAULT_SOURCE_CONFIG.canvasOrigin;
const COURSES = `${UNIMELB}/api/v1/courses?enrollment_state=active&include[]=term&per_page=100`;
const HANDBOOK = `${HANDBOOK_ORIGIN}/2026/subjects/synt10001/assessment`;
const COURSE_LIST = JSON.stringify([{ id: 900001, name: 'Synthetic Course', course_code: 'SYNT10001_2026_SM2', term: { name: '2026 Semester 2' } }]);

describe('collectors over the dedicated browser', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  async function run(browsers: ReturnType<typeof fakeCdpBrowsers>, host: ReturnType<typeof createCdpHost>, script: string, args: string[], usesBrowser = true) {
    const env = sourceConfigEnv({ ...DEFAULT_SOURCE_CONFIG, browser: 'cdp-chrome' });
    return spawnCollector({ source: 'canvas', script, args, env, usesBrowser, cwd: repoDir, registerStop: () => () => {}, signal: new AbortController().signal, browserHost: host });
  }

  it('keeps one browser across the Canvas and framework-source collectors of a job', async () => {
    dir = await mkdtemp(join(tmpdir(), 'studyorbit-cdp-'));
    const browsers = fakeCdpBrowsers({
      [COURSES]: { readyStates: ['loading', 'complete'], json: { status: 200, body: COURSE_LIST, link: null } },
      [HANDBOOK]: { text: 'SYNT10001 Assessment: synthetic essay 40%' },
    });
    const host = createCdpHost({ projectDir: dir, platform: 'linux', env: {}, start: browsers.start });
    const canvas = await run(browsers, host, 'sources/canvas/collect.mjs', ['discover', join(dir, 'courses.json')]);
    expect(canvas.code, canvas.error).toBe(0);
    const list = JSON.parse(await readFile(join(dir, 'courses.json'), 'utf8'));
    expect(list.courses.map((course: { id: string }) => course.id)).toEqual(['900001']);
    const handbook = await run(browsers, host, 'institutions/unimelb/handbook-collect.mjs', ['SYNT10001', '2026', join(dir, 'handbook.json')]);
    expect(handbook.code, handbook.error).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'handbook.json'), 'utf8')).text).toContain('synthetic essay');
    expect(browsers.launches).toHaveLength(1);
    expect(browsers.alive()).toBe(1);
    expect(browsers.methods().filter(method => method === 'Target.closeTarget')).toHaveLength(2);
    expect(browsers.methods()).not.toContain('Browser.close');
    await host.shutdown();
    expect(browsers.alive()).toBe(0);
  });

  it('fails the source with the sign-in message and exit 77 when Canvas redirects', async () => {
    dir = await mkdtemp(join(tmpdir(), 'studyorbit-cdp-'));
    const browsers = fakeCdpBrowsers({ [COURSES]: { finalUrl: 'https://login.example.edu/sso', text: 'sign-in form' } });
    const host = createCdpHost({ projectDir: dir, platform: 'linux', env: {}, start: browsers.start });
    const result = await run(browsers, host, 'sources/canvas/collect.mjs', ['discover', join(dir, 'courses.json')]);
    expect(result.code).toBe(EX_SIGN_IN);
    expect(result.error).toContain(CDP_SIGN_IN);
    expect(browsers.commands.filter(command => command.method === 'Runtime.evaluate')).toEqual([]);
    expect(browsers.methods().at(-1)).toBe('Target.closeTarget');
    await host.shutdown();
  });

  it('gives no IPC channel to a collector that does not use the browser, which then cannot reach it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'studyorbit-cdp-'));
    const browsers = fakeCdpBrowsers();
    const host = createCdpHost({ projectDir: dir, platform: 'linux', env: {}, start: browsers.start });
    const result = await run(browsers, host, 'sources/canvas/collect.mjs', ['discover', join(dir, 'courses.json')], false);
    expect(result.code).toBe(1);
    expect(result.error).toContain(CDP_NEEDS_SERVER);
    expect(browsers.launches).toHaveLength(0);
    await host.shutdown();
  });
});
