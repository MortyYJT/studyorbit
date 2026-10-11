import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { capture, type CaptureDependencies } from '../../src/capture/command.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { CANVAS_ORIGIN, ED_ORIGIN } from '../../src/capture/discovery.js';
import type { CaptureSelection, SelectionPersistence } from '../../src/capture/selection-store.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
vi.mock('playwright', () => ({ chromium: { executablePath: () => '/synthetic/browser', launchPersistentContext: vi.fn(async () => { throw Error('Use injected synthetic launcher'); }) } }));
const selection: CaptureSelection = { version: 1, courses: [
  { source: 'canvas', origin: CANVAS_ORIGIN, id: '101', term: { label: 'Synthetic' } },
  { source: 'ed', origin: ED_ORIGIN, id: '202', term: { label: '2026 Synthetic', year: 2026, session: 'Synthetic' } },
] };
const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function setup(stored: CaptureSelection | null = selection) {
  const home = mkdtempSync(join(tmpdir(), 'capture-synthetic-')); homes.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  const store: SelectionPersistence = { load: vi.fn<SelectionPersistence['load']>(async () => stored ? { status: 'valid', selection: stored } : { status: 'absent' }), save: vi.fn(async s => { stored = s; }) };
  const active = { isClosed: () => false, url: () => `${CANVAS_ORIGIN}/courses/101`, evaluate: async () => true };
  const context = Object.assign(new EventEmitter(), { pages: () => [active], close: vi.fn(async () => {}) });
  const stdout = vi.fn(); const stderr = vi.fn(); const release = vi.fn();
  const canvas = vi.fn<NonNullable<CaptureDependencies['canvasRunner']>>(async () => ({ source: 'canvas' as const, status: 'completed' as const, saved: 1, failed: 0, skipped: 0, attempted: 1, body: 'Synthetic Private Raw' }));
  const ed = vi.fn<NonNullable<CaptureDependencies['edRunner']>>(async () => ({ source: 'ed' as const, status: 'completed' as const, saved: 2, failed: 0, skipped: 0, attempted: 2, gaps: [], body: 'Synthetic Classmate' }));
  const discover = vi.fn(async () => [
    { source: 'canvas' as const, status: 'available' as const, courses: [{ ...selection.courses[0], name: 'Synthetic Canvas' }], skipped: 0 },
    { source: 'ed' as const, status: 'available' as const, courses: [{ ...selection.courses[1], name: 'Synthetic Ed' }], skipped: 0 },
  ]);
  let now = 0;
  const dependencies: CaptureDependencies = { store, stdout, stderr, acquireLock: () => release,
    chooseBrowser: async () => 'msedge', launch: vi.fn(async () => context as never),
    canvasRunner: canvas, edRunner: ed, discover, limiter: () => new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } }) };
  return { dependencies, store, context, stdout, stderr, release, canvas, ed, discover };
}
it.each(['absent', 'invalid', 'reselect'])('rejects non-TTY %s selection before lock/browser/network', async kind => {
  const f = setup(null);
  if (kind === 'invalid') f.store.load = async () => ({ status: 'invalid' });
  if (kind === 'reselect') f.store.load = async () => ({ status: 'valid', selection });
  f.dependencies.acquireLock = vi.fn(() => { throw Error('must not lock'); });
  await capture({ isTTY: false, reselect: kind === 'reselect' }, f.dependencies);
  expect(f.stdout).toHaveBeenCalledTimes(1); expect(JSON.parse(f.stdout.mock.calls[0][0])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(f.dependencies.acquireLock).not.toHaveBeenCalled(); expect(f.dependencies.launch).not.toHaveBeenCalled(); expect(f.discover).not.toHaveBeenCalled();
});
it.each([false, true])('non-TTY plain/--crawl=%s runs once, reuses selection and emits only bounded safe counts', async crawl => {
  const f = setup(); await capture({ isTTY: false, crawl }, f.dependencies);
  expect(f.canvas).toHaveBeenCalledTimes(1); expect(f.ed).toHaveBeenCalledTimes(1); expect(f.discover).not.toHaveBeenCalled();
  expect(f.stdout).toHaveBeenCalledTimes(1); const output = f.stdout.mock.calls[0][0];
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024 + 1);
  expect(output).not.toMatch(/Synthetic Private Raw|Synthetic Classmate/);
  expect(JSON.parse(output)).toMatchObject({ ok: true, data: { sources: [{ source: 'canvas', saved: 1 }, { source: 'ed', saved: 2 }] } });
  expect(f.canvas.mock.calls[0][0].limiter).toBe(f.ed.mock.calls[0][0].limiter);
  expect(f.release).toHaveBeenCalledTimes(1); expect(f.context.close).toHaveBeenCalledTimes(1);
});
it.each(['lock', 'preflight', 'launch'])('non-TTY %s failure emits exactly one safe envelope', async stage => {
  const f = setup(); const failure = () => { throw stage === 'lock' ? new CourseworkError('LOCKED', 'synthetic holder') : Error('private raw failure'); };
  if (stage === 'lock') f.dependencies.acquireLock = failure;
  if (stage === 'preflight') f.dependencies.chooseBrowser = failure;
  if (stage === 'launch') f.dependencies.launch = failure;
  await capture({ isTTY: false }, f.dependencies);
  expect(f.stdout).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.stdout.mock.calls[0][0])).toMatchObject({ ok: false, error: { code: stage === 'lock' ? 'LOCKED' : 'SOURCE_UNAVAILABLE' } });
  expect(f.stdout.mock.calls[0][0]).not.toContain('private raw failure');
});
it('interactive lock still throws LOCKED for CLI exit 3', async () => {
  const f = setup(); f.dependencies.acquireLock = () => { throw new CourseworkError('LOCKED', 'synthetic holder'); };
  await expect(capture({ isTTY: true }, f.dependencies)).rejects.toMatchObject({ code: 'LOCKED' }); expect(f.stdout).not.toHaveBeenCalled();
});
it.each([false, true])('TTY --crawl resolves picker first with reselect=%s and reuses discovery', async reselect => {
  const f = setup(reselect ? selection : null);
  const answers = reselect ? ['done'] : ['1', '2', 'done']; const terminal = { write: vi.fn(), question: vi.fn(async () => answers.shift()!) };
  f.dependencies.terminal = () => Object.assign(new EventEmitter(), terminal, { close: vi.fn(), async *[Symbol.asyncIterator]() {} }) as never;
  await capture({ isTTY: true, crawl: true, reselect }, f.dependencies);
  expect(f.discover).toHaveBeenCalledTimes(1); expect(f.store.save).toHaveBeenCalledTimes(1);
  expect(f.canvas).toHaveBeenCalledTimes(1); expect(f.ed).toHaveBeenCalledTimes(1);
  expect(f.canvas.mock.calls[0][0].discovery).toBeDefined();
  expect(f.ed.mock.calls[0][0].discoveryCaptured).toBe(true);
});
it('cancelled TTY reselection preserves store and schedules no providers', async () => {
  const f = setup(); f.dependencies.terminal = () => Object.assign(new EventEmitter(), {
    write: vi.fn(), question: async () => 'q', close: vi.fn(), async *[Symbol.asyncIterator]() {},
  }) as never;
  await capture({ isTTY: true, reselect: true }, f.dependencies);
  expect(f.store.save).not.toHaveBeenCalled(); expect(f.canvas).not.toHaveBeenCalled(); expect(f.ed).not.toHaveBeenCalled();
});
it('first interactive c picks and persists, then later c reuses without rediscovery', async () => {
  const f = setup(null); const answers = ['1', '2', 'done'];
  f.dependencies.terminal = () => Object.assign(new EventEmitter(), {
    write: vi.fn(), question: vi.fn(async () => answers.shift()!), close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield 'c'; await vi.waitFor(() => expect(f.canvas).toHaveBeenCalledTimes(1));
      // Let the session's in-flight promise settle before the second command.
      await new Promise(resolve => setImmediate(resolve));
      yield 'c'; await vi.waitFor(() => expect(f.canvas).toHaveBeenCalledTimes(2)); yield 'q';
    },
  }) as never;
  await capture({ isTTY: true }, f.dependencies);
  expect(f.discover).toHaveBeenCalledTimes(1); expect(f.store.save).toHaveBeenCalledTimes(1);
  expect(f.canvas.mock.calls[0][0].selection.courses).toEqual(selection.courses);
  expect(f.canvas.mock.calls[1][0].selection.courses).toEqual(selection.courses);
});
it('empty selection schedules neither runner and absent Canvas implementation is explicit', async () => {
  const f = setup({ version: 1, courses: [] }); await capture({ isTTY: false }, f.dependencies);
  expect(f.canvas).not.toHaveBeenCalled(); expect(f.ed).not.toHaveBeenCalled();
  f.store.load = async () => ({ status: 'valid', selection }); delete f.dependencies.canvasRunner;
  await capture({ isTTY: false }, f.dependencies);
  expect(JSON.parse(f.stdout.mock.calls[1][0])).toMatchObject({ data: { sources: [{ source: 'canvas', status: 'notStarted', error: { code: 'SOURCE_UNAVAILABLE' } }, { source: 'ed', status: 'completed' }] } });
});
it('unavailable Ed discovery is retained in source outcome without a second discovery read', async () => {
  const f = setup(); f.dependencies.discover = async () => [
    { source: 'canvas', status: 'available', courses: [{ ...selection.courses[0], name: 'Synthetic Canvas' }], skipped: 0 },
    { source: 'ed', status: 'unavailable', error: new CourseworkError('AUTH_EXPIRED', 'Synthetic Ed auth') },
  ];
  f.dependencies.terminal = () => Object.assign(new EventEmitter(), { write: vi.fn(), question: async () => 'done', close: vi.fn(), async *[Symbol.asyncIterator]() {} }) as never;
  await capture({ isTTY: true, reselect: true, crawl: true }, f.dependencies);
  expect(f.canvas).toHaveBeenCalledTimes(1); expect(f.ed).not.toHaveBeenCalled();
  expect(f.stderr).toHaveBeenCalledWith(expect.stringContaining('AUTH_EXPIRED'));
});

it('reports safe Ed endpoint gaps while withholding raw runner diagnostics', async () => {
  const f = setup(); f.dependencies.edRunner = async () => ({ source: 'ed', status: 'partial', saved: 0, failed: 1, skipped: 0, attempted: 1,
    gaps: [{ endpoint: '/api/lessons/slides/21', status: 400, reason: 'http' },
      { endpoint: 'https://evil.invalid/private?token=synthetic-secret', reason: 'Synthetic Classmate' }] });
  await capture({ isTTY: false }, f.dependencies);
  const output = f.stdout.mock.calls[0][0];
  expect(JSON.parse(output).data.edGaps).toEqual([{ endpoint: '/api/lessons/slides/21', status: 400, reason: 'http' }]);
  expect(output).not.toMatch(/synthetic-secret|Synthetic Classmate|evil.invalid/);
});
