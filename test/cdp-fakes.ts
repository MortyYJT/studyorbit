// A fake Chrome/Edge for the experimental CDP bridge's tests (openspec change generic-adapters, design §7): a fake
// process whose fd 3/4 are in-memory streams, answering the allowed CDP commands from a synthetic scenario through the
// real pipe transport. Never a real browser. `start` has the shape of `startCdpBrowser`.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { READ_EXPRESSIONS } from '../scripts/browser/bridge.mjs';
import { createCdpPipe, STATE_EXPRESSION } from '../scripts/browser/cdp-pipe.mjs';
import type { StartedBrowser, StartOptions } from '../scripts/browser/cdp-launch.mjs';

/** What a page answers, keyed by its URL without the fragment. */
export type FakePage = {
  /** The URL the tab ends on (a sign-in redirect); default the opened URL. */
  finalUrl?: string;
  /** `document.readyState` answers in order, the last repeating; default `complete`. */
  readyStates?: string[];
  json?: { status: number; body: string; link: string | null };
  text?: string;
  navigationStatus?: number;
  /** The URL the tab moves to right after a read expression ran (a page that navigates itself). */
  urlAfterRead?: string;
};
export type FakeCommand = { method: string; params: Record<string, unknown>; sessionId?: string; launch: number };

export function fakeCdpBrowsers(pages: Record<string, FakePage> = {}) {
  const commands: FakeCommand[] = [];
  const launches: StartOptions[] = [];
  const live: { exit(): void; alive(): boolean }[] = [];
  let failNext: Error | null = null;
  let targetCount = 0;

  async function start(options: StartOptions): Promise<StartedBrowser> {
    launches.push(options);
    if (failNext) { const error = failNext; failNext = null; throw error; }
    const launch = launches.length;
    const child = Object.assign(new EventEmitter(), { pid: 1000 + launch, kill: () => { exit(); return true; } });
    const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
    const targets = new Map<string, { url: string; page: FakePage; reads: number; sessionId: string | null }>();
    let alive = true;
    let resolveExit!: (value: { code: number | null; signal: string | null; error: Error | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null; error: Error | null }>(resolve => { resolveExit = resolve; });
    function exit() {
      if (!alive) return;
      alive = false;
      fromBrowser.end();
      resolveExit({ code: 0, signal: null, error: null });
      child.emit('exit', 0, null);
    }
    const answer = (id: number, result: unknown) => fromBrowser.write(`${JSON.stringify({ id, result })}\0`);
    const fail = (id: number, message: string) => fromBrowser.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\0`);
    toBrowser.on('data', (chunk: Buffer) => {
      for (const text of chunk.toString('utf8').split('\0').filter(Boolean)) {
        const { id, method, params, sessionId } = JSON.parse(text);
        commands.push({ method, params, ...(sessionId ? { sessionId } : {}), launch });
        if (method === 'Browser.close') { answer(id, {}); setImmediate(exit); continue; }
        if (method === 'Target.createTarget') {
          const targetId = `T${++targetCount}`;
          const page = pages[String(params.url).split('#')[0]!] ?? {};
          targets.set(targetId, { url: page.finalUrl ?? params.url, page, reads: 0, sessionId: null });
          answer(id, { targetId });
          continue;
        }
        if (method === 'Target.getTargetInfo') {
          if (!params.targetId) { answer(id, { targetInfo: { targetId: 'browser', type: 'browser', url: '' } }); continue; }
          const target = targets.get(params.targetId);
          if (!target) fail(id, 'No target with given id found'); else answer(id, { targetInfo: { targetId: params.targetId, type: 'page', url: target.url } });
          continue;
        }
        if (method === 'Target.attachToTarget') {
          const target = targets.get(params.targetId);
          if (!target) { fail(id, 'No target with given id found'); continue; }
          target.sessionId = `S-${params.targetId}`;
          answer(id, { sessionId: target.sessionId });
          continue;
        }
        if (method === 'Target.closeTarget') {
          if (!targets.delete(params.targetId)) fail(id, 'No target with given id found'); else answer(id, { success: true });
          continue;
        }
        if (method === 'Runtime.evaluate') {
          const target = [...targets.values()].find(item => item.sessionId === sessionId);
          if (!target) { fail(id, 'Session with given id not found'); continue; }
          const { page } = target;
          let value: string;
          if (params.expression === STATE_EXPRESSION) {
            const states = page.readyStates ?? ['complete'];
            value = states[Math.min(target.reads++, states.length - 1)]!;
          } else if (params.expression === READ_EXPRESSIONS['same-origin-json']) value = JSON.stringify(page.json ?? { status: 404, body: '', link: null });
          else if (params.expression === READ_EXPRESSIONS['body-text']) value = page.text ?? '';
          else value = String(page.navigationStatus ?? '');
          if (params.expression !== STATE_EXPRESSION && page.urlAfterRead) target.url = page.urlAfterRead;
          answer(id, { result: { type: 'string', value } });
          continue;
        }
        fail(id, `unexpected ${method}`);
      }
    });
    const pipe = createCdpPipe({ input: fromBrowser, output: toBrowser });
    live.push({ exit, alive: () => alive });
    return { id: options.id, browserPath: options.browserPath ?? null, pipe, child: child as never, exited, running: () => alive };
  }

  return {
    start, commands, launches,
    /** The owner closes the browser window (the process exits). */
    closeWindow() { live.at(-1)?.exit(); },
    failNextLaunch(error: Error) { failNext = error; },
    /** Browser processes still running. */
    alive: () => live.filter(item => item.alive()).length,
    methods: () => commands.map(command => command.method),
  };
}

/** A fake collector process with a Node IPC channel: `request` sends a bridge request and waits for the reply. */
export function fakeCollectorChild() {
  const child = Object.assign(new EventEmitter(), {
    connected: true, sent: [] as unknown[],
    send(message: unknown, callback?: (error: Error | null) => void) { child.sent.push(message); child.emit('reply', message); callback?.(null); return true; },
  });
  let nextId = 1;
  function request(message: Record<string, unknown>): Promise<{ id: number; ok: boolean; value?: unknown; error?: string }> {
    const id = nextId++;
    return new Promise(resolve => {
      const onReply = (reply: { id: number }) => { if (reply.id === id) { child.off('reply', onReply); resolve(reply as never); } };
      child.on('reply', onReply);
      child.emit('message', { id, ...message });
    });
  }
  const exit = () => { child.connected = false; child.emit('disconnect'); child.emit('exit', 0, null); };
  return { child, request, exit };
}
