import { describe, expect, it } from 'vitest';
import { READ_EXPRESSIONS } from '../scripts/browser/bridge.mjs';
import { createCdpHost } from '../scripts/browser/cdp-host.mjs';
import { PROFILE_IN_USE } from '../scripts/browser/cdp-launch.mjs';
import { DEFAULT_SOURCE_CONFIG, sourceConfigEnv } from '../scripts/sources/config.mjs';
import { fakeCdpBrowsers, fakeCollectorChild } from './cdp-fakes.ts';

// The server-owned dedicated browser of the experimental CDP bridge (openspec change generic-adapters, design §7,
// decision #446): one long-lived browser launched on demand and kept across collectors, IPC requests from fake
// collector children, the origin and method allowlists, relaunch, settings change and shutdown. Fake browser only.

const ORIGIN = 'https://canvas.example.edu';
const COURSES = `${ORIGIN}/api/v1/courses?enrollment_state=active&include[]=term&per_page=100`;
const PREFIX = `${ORIGIN}/api/v1/courses`;
const client = { browser: 'cdp-chrome', browserPath: null, allowedOrigins: [ORIGIN] };
const marked = (url: string) => `${url}#coursework-00000000-0000-4000-8000-000000000000`;

function setup(pages = {}) {
  const browsers = fakeCdpBrowsers(pages);
  const host = createCdpHost({ projectDir: '/p', platform: 'linux', env: {}, start: browsers.start });
  return { browsers, host };
}

describe('the dedicated browser host', () => {
  it('launches on the first request, opens a background tab and answers state and reads', async () => {
    const { browsers, host } = setup({ [COURSES]: { readyStates: ['loading', 'complete'], json: { status: 200, body: '[]', link: null } } });
    const collector = fakeCollectorChild();
    host.attach(collector.child, client);
    expect(host.running()).toBe(false);
    const opened = await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    expect(opened).toMatchObject({ ok: true, value: 'T1' });
    expect(host.running()).toBe(true);
    expect(browsers.launches.map(launch => [launch.id, launch.projectDir, launch.browserPath])).toEqual([['cdp-chrome', '/p', null]]);
    expect(await collector.request({ op: 'state', tab: 'T1', prefix: PREFIX })).toMatchObject({ ok: true, value: 'loading' });
    expect(await collector.request({ op: 'state', tab: 'T1', prefix: PREFIX })).toMatchObject({ ok: true, value: 'ready' });
    const read = await collector.request({ op: 'read', tab: 'T1', prefix: PREFIX, kind: 'same-origin-json' });
    expect(JSON.parse(read.value as string)).toEqual({ status: 200, body: '[]', link: null });
    expect(await collector.request({ op: 'close', tab: 'T1' })).toMatchObject({ ok: true });
    expect(browsers.commands.map(command => [command.method, command.params.background ?? command.params.expression ?? command.params.flatten ?? null, command.sessionId ?? null])).toEqual([
      ['Target.createTarget', true, null], ['Target.attachToTarget', true, null],
      ['Target.getTargetInfo', null, null], ['Runtime.evaluate', 'document.readyState', 'S-T1'],
      ['Target.getTargetInfo', null, null], ['Runtime.evaluate', 'document.readyState', 'S-T1'],
      ['Target.getTargetInfo', null, null], ['Runtime.evaluate', 'document.readyState', 'S-T1'], ['Runtime.evaluate', READ_EXPRESSIONS['same-origin-json'], 'S-T1'],
      ['Target.closeTarget', null, null],
    ]);
    await host.shutdown();
  });

  it('reports loading while the URL matches but the document is interactive, and redirect off the prefix, reading nothing', async () => {
    const signIn = 'https://login.example.edu/sso?return=x';
    const { browsers, host } = setup({ [COURSES]: { readyStates: ['interactive'] }, [`${ORIGIN}/api/v1/courses/1/assignment_groups`]: { finalUrl: signIn, text: 'secret sign-in page' } });
    const collector = fakeCollectorChild();
    host.attach(collector.child, client);
    await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    expect(await collector.request({ op: 'state', tab: 'T1', prefix: PREFIX })).toMatchObject({ value: 'loading' });
    expect(await collector.request({ op: 'read', tab: 'T1', prefix: PREFIX, kind: 'body-text' })).toMatchObject({ ok: false, error: 'PAGE_STILL_LOADING' });
    await collector.request({ op: 'open', url: marked(`${ORIGIN}/api/v1/courses/1/assignment_groups`), prefix: PREFIX });
    expect(await collector.request({ op: 'state', tab: 'T2', prefix: PREFIX })).toMatchObject({ value: 'redirect' });
    // Even when asked, a page on another origin is never read.
    expect(await collector.request({ op: 'read', tab: 'T2', prefix: 'https://login.example.edu/', kind: 'body-text' })).toMatchObject({ ok: false, error: 'UNEXPECTED_URL' });
    expect(await collector.request({ op: 'read', tab: 'T2', prefix: PREFIX, kind: 'navigation-status' })).toMatchObject({ ok: false, error: 'UNEXPECTED_URL' });
    const evaluated = browsers.commands.filter(command => command.method === 'Runtime.evaluate').map(command => command.params.expression);
    expect(evaluated).toEqual(['document.readyState', 'document.readyState']);
    await host.shutdown();
  });

  it('treats a tab still on about:blank as loading', async () => {
    const { host } = setup({ [COURSES]: { finalUrl: 'about:blank' } });
    const collector = fakeCollectorChild();
    host.attach(collector.child, client);
    await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    expect(await collector.request({ op: 'state', tab: 'T1', prefix: PREFIX })).toMatchObject({ value: 'loading' });
    await host.shutdown();
  });

  it('refuses foreign origins, unknown operations and read kinds, and other clients\' tabs before any browser call', async () => {
    const { browsers, host } = setup();
    const collector = fakeCollectorChild();
    host.attach(collector.child, client);
    for (const message of [
      { op: 'open', url: 'https://example.org/#coursework-x', prefix: 'https://example.org/' },
      { op: 'open', url: marked(COURSES), prefix: 'https://example.org/' },
      { op: 'open', url: `http://canvas.example.edu/api/v1/courses`, prefix: PREFIX },
      { op: 'evaluate', tab: 'T1', expression: 'document.cookie' },
      { op: 'read', tab: 'T1', prefix: PREFIX, kind: 'cookies' },
      { op: 'state', tab: 'T9', prefix: PREFIX },
      { op: 'open', url: 42, prefix: PREFIX },
    ]) expect(await collector.request(message), JSON.stringify(message)).toMatchObject({ ok: false });
    expect(browsers.launches).toHaveLength(0);
    expect(browsers.commands).toHaveLength(0);
    // A message without a numeric id gets no answer at all.
    collector.child.emit('message', { op: 'open', url: marked(COURSES), prefix: PREFIX });
    collector.child.emit('message', 'open');
    await new Promise(resolve => setImmediate(resolve));
    expect(collector.child.sent).toHaveLength(7);

    const other = fakeCollectorChild();
    host.attach(other.child, client);
    await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    expect(await other.request({ op: 'read', tab: 'T1', prefix: PREFIX, kind: 'body-text' })).toMatchObject({ ok: false, error: '标签页不存在或已关闭' });
    expect(await other.request({ op: 'close', tab: 'T1' })).toMatchObject({ ok: false });
    await host.shutdown();
  });

  it('keeps one browser across two collectors and closes only the tabs a stopped collector left open', async () => {
    const { browsers, host } = setup();
    const canvas = fakeCollectorChild();
    host.attach(canvas.child, client);
    await canvas.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    await canvas.request({ op: 'open', url: marked(`${PREFIX}/1/assignments`), prefix: PREFIX });
    await canvas.request({ op: 'close', tab: 'T1' });
    canvas.exit();
    await new Promise(resolve => setImmediate(resolve));
    const framework = fakeCollectorChild();
    host.attach(framework.child, { ...client, allowedOrigins: [ORIGIN, 'https://framework.example.edu'] });
    await framework.request({ op: 'open', url: marked('https://framework.example.edu/2026/x'), prefix: 'https://framework.example.edu/2026/x' });
    framework.exit();
    await new Promise(resolve => setImmediate(resolve));
    expect(browsers.launches).toHaveLength(1);
    expect(browsers.alive()).toBe(1);
    expect(host.running()).toBe(true);
    expect(browsers.commands.filter(command => command.method === 'Target.closeTarget').map(command => command.params.targetId)).toEqual(['T1', 'T2', 'T3']);
    expect(browsers.methods()).not.toContain('Browser.close');
    await host.shutdown();
    expect(browsers.methods().at(-1)).toBe('Browser.close');
    expect(browsers.alive()).toBe(0);
  });

  it('relaunches after the owner closed the window, and fails the tabs of the closed browser', async () => {
    const { browsers, host } = setup();
    const collector = fakeCollectorChild();
    host.attach(collector.child, client);
    await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    browsers.closeWindow();
    await new Promise(resolve => setImmediate(resolve));
    expect(host.running()).toBe(false);
    expect(await collector.request({ op: 'state', tab: 'T1', prefix: PREFIX })).toMatchObject({ ok: false, error: '标签页不存在或已关闭' });
    expect(await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX })).toMatchObject({ ok: true, value: 'T2' });
    expect(browsers.launches).toHaveLength(2);
    await host.shutdown();
  });

  it('closes the browser when the browser setting changes, and keeps it when it does not', async () => {
    const { browsers, host } = setup();
    await host.openSignIn({ browser: 'cdp-chrome', browserPath: null, canvasOrigin: ORIGIN });
    expect(browsers.commands[0]).toMatchObject({ method: 'Target.createTarget', params: { url: `${ORIGIN}/`, background: false } });
    await host.settingsChanged({ browser: 'cdp-chrome', browserPath: null });
    expect(browsers.alive()).toBe(1);
    await host.settingsChanged({ browser: 'cdp-edge', browserPath: null });
    expect(browsers.alive()).toBe(0);
    expect(host.running()).toBe(false);
    await host.openSignIn({ browser: 'cdp-chrome', browserPath: null, canvasOrigin: ORIGIN });
    await host.settingsChanged({ browser: 'cdp-chrome', browserPath: '/opt/chrome/chrome' });
    expect(browsers.alive()).toBe(0);
    await host.openSignIn({ browser: 'cdp-chrome', browserPath: null, canvasOrigin: ORIGIN });
    await host.settingsChanged({ browser: 'edge-applescript', browserPath: null });
    expect(browsers.alive()).toBe(0);
    // A collector configured for another browser than the running one gets a fresh browser of its own kind.
    await host.openSignIn({ browser: 'cdp-chrome', browserPath: null, canvasOrigin: ORIGIN });
    const collector = fakeCollectorChild();
    host.attach(collector.child, { ...client, browser: 'cdp-edge' });
    await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX });
    expect(browsers.launches.map(launch => launch.id)).toEqual(['cdp-chrome', 'cdp-chrome', 'cdp-chrome', 'cdp-chrome', 'cdp-edge']);
    expect(browsers.alive()).toBe(1);
    await host.shutdown();
  });

  it('passes a handover failure on and refuses work after shutdown', async () => {
    const { browsers, host } = setup();
    browsers.failNextLaunch(new Error(PROFILE_IN_USE));
    await expect(host.openSignIn({ browser: 'cdp-chrome', browserPath: null, canvasOrigin: ORIGIN })).rejects.toThrow(PROFILE_IN_USE);
    const collector = fakeCollectorChild();
    host.attach(collector.child, client);
    await host.shutdown();
    expect(await collector.request({ op: 'open', url: marked(COURSES), prefix: PREFIX })).toMatchObject({ ok: false, error: '本地服务正在关闭' });
    await expect(host.openSignIn({ browser: 'cdp-chrome', browserPath: null, canvasOrigin: ORIGIN })).rejects.toThrow('本地服务正在关闭');
  });

  it('builds a collector client only from a CDP collector configuration', () => {
    const { host } = setup();
    expect(host.clientFor({})).toBeNull();
    expect(host.clientFor(sourceConfigEnv(DEFAULT_SOURCE_CONFIG))).toBeNull();
    const env = sourceConfigEnv({ ...DEFAULT_SOURCE_CONFIG, institution: 'generic', canvasOrigin: ORIGIN, browser: 'cdp-edge', browserPath: '/opt/edge/msedge' });
    expect(host.clientFor(env)).toEqual({ browser: 'cdp-edge', browserPath: '/opt/edge/msedge', allowedOrigins: [ORIGIN] });
    const unimelb = host.clientFor(sourceConfigEnv({ ...DEFAULT_SOURCE_CONFIG, browser: 'cdp-chrome' }));
    expect(unimelb?.allowedOrigins).toHaveLength(2);
  });
});
