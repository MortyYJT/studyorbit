import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { activePage, captureSession, launchSettings, prepareCommands, confirmBundledBrowser } from '../../src/capture/session.js';

async function* commands(...lines: string[]) { yield* lines; }
function fakePage(focused = false) {
  return { isClosed: () => false, evaluate: vi.fn(async () => focused) };
}
it('start capture explains manual sign-in and uses the headed persistent profile', () => {
  expect(launchSettings('/synthetic/home', 'chrome')).toEqual({
    profile: '/synthetic/home/profiles/default', options: { headless: false, channel: 'chrome' },
  });
});
it('s saves the focused tab, q closes the context, and no form APIs are needed', async () => {
  const first = fakePage(true); const last = fakePage();
  const context = { pages: () => [first, last], close: vi.fn(async () => {}) };
  const save = vi.fn(async () => '/synthetic/snapshot');
  const log = vi.fn();
  await captureSession(context, commands('s', 'q', 's'), save, log);
  expect(save).toHaveBeenCalledExactlyOnceWith(first);
  expect(log.mock.calls.flat().join(' ')).toMatch(/sign in.*s.*q/i);
  expect(context.close).toHaveBeenCalledOnce();
});
it('falls back to the most recent tab when terminal focus leaves all pages unfocused', async () => {
  const first = fakePage(); const last = fakePage();
  expect(await activePage({ pages: () => [first, last] })).toBe(last);
});
it('keeps the session available after a save fails and closes on terminal EOF', async () => {
  const context = { pages: () => [fakePage()], close: vi.fn(async () => {}) };
  const save = vi.fn().mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValueOnce('/synthetic/snapshot');
  const log = vi.fn();
  await captureSession(context, commands('s', 's'), save, log);
  expect(save).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith('Unable to save this page; try again after it finishes loading.');
  expect(context.close).toHaveBeenCalledOnce();
});
it('reports no open page without trying to save', async () => {
  const save = vi.fn(); const log = vi.fn();
  await captureSession({ pages: () => [], close: async () => {} }, commands('s', 'q'), save, log);
  expect(save).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('No open page to save.');
});
it('selects the visible tab when Chrome loses focus to the terminal', async () => {
  const selected = { isClosed: () => false, evaluate: vi.fn(async (expression: string) => expression.includes('visibilityState')) };
  const background = fakePage();
  expect(await activePage({ pages: () => [selected, background] })).toBe(selected);
});
it('closes the browser even when terminal input fails', async () => {
  const context = { pages: () => [], close: vi.fn(async () => {}) };
  async function* failingCommands(): AsyncIterable<string> { throw new Error('terminal closed unexpectedly'); }
  await expect(captureSession(context, failingCommands(), vi.fn(), vi.fn())).rejects.toThrow('terminal closed unexpectedly');
  expect(context.close).toHaveBeenCalledOnce();
});

it('remembers terminal EOF that occurs before the browser is ready', async () => {
  const input = new PassThrough();
  const terminal = createInterface({ input });
  const commands = prepareCommands(terminal);
  terminal.close();
  const context = { pages: () => [], close: vi.fn(async () => {}) };
  await captureSession(context, commands, vi.fn(), vi.fn());
  expect(context.close).toHaveBeenCalledOnce();
  input.destroy();
});

it('fallback asks first and accepts only an explicit affirmative answer', async () => {
  const question = vi.fn().mockResolvedValueOnce('no').mockResolvedValueOnce('yes');
  const signal = new AbortController().signal;
  expect(await confirmBundledBrowser({ question }, signal)).toBe(false);
  expect(await confirmBundledBrowser({ question }, signal)).toBe(true);
  expect(question).toHaveBeenCalledTimes(2);
});
it('cancels a pending fallback question when the terminal closes', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const terminal = createInterface({ input, output });
  const controller = new AbortController();
  const answer = confirmBundledBrowser(terminal, controller.signal);
  terminal.close(); controller.abort();
  expect(await answer).toBe(false);
  input.destroy(); output.destroy();
});

it('starts c in the background, refuses second c, keeps s on the active tab, and q aborts then waits', async () => {
  const page = fakePage(true); const context = { pages: () => [page], close: vi.fn(async () => {}) };
  const save = vi.fn(async () => '/synthetic/snapshot'); const log = vi.fn();
  let resolveCrawl!: () => void; let crawlSignal!: AbortSignal;
  const crawl = vi.fn(async (_page: unknown, signal: AbortSignal) => { crawlSignal = signal; await new Promise<void>(resolve => { resolveCrawl = resolve; }); });
  const running = captureSession(context, commands('c', 'c', 's', 'q'), save, log, { crawl });
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(crawl).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith('a crawl is already running');
  await vi.waitFor(() => expect(crawlSignal.aborted).toBe(true));
  expect(context.close).not.toHaveBeenCalled(); resolveCrawl(); await running;
  expect(context.close).toHaveBeenCalledOnce();
  expect(log.mock.calls[0][0]).toMatch(/s.*c.*q/);
});
it.each(['SIGINT', 'SIGTERM', 'browser close', 'terminal EOF'])('%s aborts a crawl after its current load', async () => {
  const controller = new AbortController(); const page = fakePage(true);
  const context = { pages: () => [page], close: vi.fn(async () => {}) };
  let finish!: () => void; let signal!: AbortSignal;
  const crawl = vi.fn(async (_page: unknown, value: AbortSignal) => { signal = value; await new Promise<void>(resolve => { finish = resolve; }); });
  async function* lines() { yield 'c'; await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })); }
  const running = captureSession(context, lines(), vi.fn(), vi.fn(), { crawl, signal: controller.signal });
  await vi.waitFor(() => expect(crawl).toHaveBeenCalledOnce()); controller.abort();
  expect(signal.aborted).toBe(true); expect(context.close).not.toHaveBeenCalled(); finish(); await running;
  expect(context.close).toHaveBeenCalledOnce();
});
it('c with no active tab gives a Canvas instruction without launching', async () => {
  const crawl = vi.fn(); const log = vi.fn();
  await captureSession({ pages: () => [], close: async () => {} }, commands('c', 'q'), vi.fn(), log, { crawl });
  expect(crawl).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledWith('Open a Canvas course page first.');
});
it('failed crawl is handled without an unhandled rejection and a later c can start', async () => {
  const log = vi.fn(); const crawl = vi.fn().mockRejectedValueOnce(new Error('synthetic')).mockResolvedValueOnce(undefined);
  async function* lines() { yield 'c'; await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Unable to complete the crawl.')); yield 'c'; yield 'q'; }
  await captureSession({ pages: () => [fakePage(true)], close: async () => {} }, lines(), vi.fn(), log, { crawl });
  expect(crawl).toHaveBeenCalledTimes(2);
});
