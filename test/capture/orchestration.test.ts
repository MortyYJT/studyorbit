import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { capture, type CaptureDependencies } from '../../src/capture/command.js';
import { captureSession } from '../../src/capture/session.js';
import { CANVAS_ORIGIN, ED_ORIGIN } from '../../src/capture/discovery.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import type { CaptureSelection } from '../../src/capture/selection-store.js';
vi.mock('playwright', () => ({ chromium: { executablePath: () => '/synthetic/browser' } }));
// CDP target creation has its own tests; retain real discovery, adapters and snapshot writers.
vi.mock('../../src/capture/tab.js', () => ({ openHiddenPage: async (context: { takePage(): unknown }) => context.takePage() }));
const selection: CaptureSelection = { version: 1, courses: [
  { source: 'canvas', origin: CANVAS_ORIGIN, id: '101', term: { label: 'Synthetic' } },
  { source: 'ed', origin: ED_ORIGIN, id: '202', term: { label: 'Synthetic', year: 2026, session: 'Synthetic' } },
] };
const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function fixture({ canvasExpired = false, edExpired = false, first = false, many = false, redirects = false, canvasFailure = false, canvasLoginUrl = `${CANVAS_ORIGIN}/login`, canvasNavigationError = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orchestration-synthetic-')); homes.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  let snapshotBarrier: Promise<void> | undefined; let finishSnapshot: (() => void) | undefined;
  const navigations: string[] = []; const reads: string[] = []; const saves: string[] = [];
  const canvasPage = () => {
    let url = `${CANVAS_ORIGIN}/courses/101`;
    return { url: () => url, isClosed: () => false, close: vi.fn(async () => {}),
      goto: async (target: string) => { navigations.push(target); if (canvasFailure && target.endsWith('/grades')) throw Error('synthetic failure'); url = canvasExpired ? canvasLoginUrl : redirects && target !== `${CANVAS_ORIGIN}/courses` ? `${CANVAS_ORIGIN}/courses/101/?synthetic_secret=hidden#private` : target; if (canvasNavigationError) throw Error('synthetic navigation failure'); return { status: () => 200 }; },
      waitForLoadState: async () => {},
      evaluate: async (expression: string) => expression.includes('my_courses_table')
        ? [{ id: '101', name: 'Synthetic Course', term: 'Synthetic', unpublished: false }]
        : expression.includes('querySelectorAll') ? many ? Array.from({ length: 292 }, (_, i) => `/courses/101/assignments/${i + 1}`) : [] : true,
      title: async () => 'Synthetic', content: async () => { saves.push(url); await snapshotBarrier; return '<p>Synthetic</p>'; },
      screenshot: async () => Buffer.from('synthetic'), viewportSize: () => null,
    };
  };
  const edPage = () => ({ url: () => `${ED_ORIGIN}/au/`, isClosed: () => false, close: vi.fn(async () => {}),
    evaluate: async (expression: string) => {
      const endpoint = JSON.parse(/fetch\(("[^"\n]+")/.exec(expression)![1]) as string; reads.push(endpoint);
      if (edExpired) return { kind: 'auth', code: 'AUTH_EXPIRED', status: 401 };
      return { kind: 'json', status: 200, body: endpoint === '/api/user'
        ? [{ course: { id: 202, code: 'SYN', name: 'Synthetic', year: 2026, session: 'Synthetic', status: 'active' } }]
        : endpoint.endsWith('/lessons') ? { lessons: [] } : { items: [] } };
    },
  });
  const visibleCanvas = canvasPage(); const visibleEd = { isClosed: () => false, url: () => `${ED_ORIGIN}/au/`, evaluate: async () => true };
  const queue = first ? [canvasPage(), edPage(), canvasPage()] : [canvasPage(), edPage()];
  const context = Object.assign(new EventEmitter(), { pages: () => [visibleCanvas, visibleEd], takePage: () => queue.shift()!, close: vi.fn(async () => {}) });
  let now = 0; const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const stdout = vi.fn(); const stderr = vi.fn(); const release = vi.fn();
  const answers = ['1', '2', 'done'];
  const dependencies: CaptureDependencies = { store: { load: async () => first ? { status: 'absent' } : { status: 'valid', selection }, save: vi.fn(async () => {}) },
    acquireLock: () => release, chooseBrowser: async () => 'msedge', launch: async () => context as never,
    limiter: () => limiter, stdout, stderr,
    terminal: () => Object.assign(new EventEmitter(), { output: { write: vi.fn() }, question: async () => answers.shift()!, close: vi.fn(), async *[Symbol.asyncIterator]() {} }) as never,
  };
  const data = () => JSON.parse((first ? stderr : stdout).mock.calls.at(-1)![0]).data;
  return { dependencies, context, navigations, reads, saves, limiter, data, release,
    pauseSnapshot: () => { snapshotBarrier = new Promise<void>(resolve => { finishSnapshot = resolve; }); },
    finishSnapshot: () => finishSnapshot!(),
    summaries: () => readdirSync(join(home, 'crawls')).map(name => JSON.parse(readFileSync(join(home, 'crawls', name), 'utf8'))),
  };
}
it('Ed expiry preserves completed Canvas snapshots using the production runners', async () => {
  const f = fixture({ edExpired: true }); await capture({ isTTY: false }, f.dependencies);
  expect(f.data().sources).toMatchObject([{ source: 'canvas', status: 'completed', saved: 5 }, { source: 'ed', status: 'authExpired', error: { code: 'AUTH_EXPIRED' } }]);
  expect(f.reads).toEqual(['/api/user']); expect(f.saves).toHaveLength(5);
});
it('Canvas expiry continues Ed and projects Canvas AUTH_EXPIRED', async () => {
  const f = fixture({ canvasExpired: true }); await capture({ isTTY: false }, f.dependencies);
  expect(f.data().sources).toMatchObject([{ source: 'canvas', status: 'signedOut', error: { code: 'AUTH_EXPIRED' } }, { source: 'ed', status: 'completed', saved: 4 }]);
  expect(f.navigations).toHaveLength(1); expect(f.reads).toHaveLength(4);
});
it.each([false, true])('external SSO redirects survive the unified summary with navigation error=%s', async canvasNavigationError => {
  const f = fixture({ canvasExpired: true, canvasNavigationError,
    canvasLoginUrl: 'https://synthetic-user:synthetic-password@sso.example/signin?synthetic_secret=hidden#private' });
  await capture({ isTTY: false }, f.dependencies);
  expect(f.data()).toMatchObject({ status: 'signedOut', canvas: { redirectsOmitted: 0, redirects: [
    { requestedUrl: `${CANVAS_ORIGIN}/courses`, finalUrl: 'https://sso.example/signin', alreadySaved: false },
  ] } });
  expect(f.summaries()[0]).toEqual(f.data());
  expect(JSON.stringify(f.data())).not.toMatch(/synthetic-user|synthetic-password|synthetic_secret|#private/);
});
it.each([`${CANVAS_ORIGIN}/login/saml`, 'https://sso.example/signin'])('expired Canvas discovery at %s survives reselection and continues Ed', async canvasLoginUrl => {
  const f = fixture({ first: true, canvasExpired: true, canvasLoginUrl });
  f.dependencies.store!.load = async () => ({ status: 'valid', selection });
  await capture({ isTTY: true, crawl: true, reselect: true }, { ...f.dependencies,
    terminal: () => Object.assign(new EventEmitter(), { output: { write: vi.fn() }, question: async () => 'done', close: vi.fn(), async *[Symbol.asyncIterator]() {} }) as never,
  });
  expect(f.data()).toMatchObject({ status: 'signedOut', sources: [
    { source: 'canvas', status: 'signedOut', attempted: 0, error: { code: 'AUTH_EXPIRED', next: expect.stringMatching(/sign in again/i) } },
    { source: 'ed', status: 'completed', saved: 3 },
  ], discoveryGaps: [{ source: 'canvas', code: 'AUTH_EXPIRED' }], canvas: { discoveryReused: true, redirects: [
    { requestedUrl: `${CANVAS_ORIGIN}/courses`, finalUrl: canvasLoginUrl, alreadySaved: false },
  ] } });
  expect(f.navigations).toEqual([`${CANVAS_ORIGIN}/courses`]);
  expect(f.reads).toEqual(['/api/user', '/api/courses/202/lessons', '/api/courses/202/threads?limit=30&sort=new', '/api/courses/202/resources']);
  expect(f.saves).toEqual([]);
  expect(f.summaries()[0]).toEqual(f.data());
});
it('first selection shares 300 attempts across real discovery, Canvas and Ed without repeating discovery', async () => {
  const f = fixture({ first: true, many: true }); await capture({ isTTY: true, crawl: true }, f.dependencies);
  expect(f.limiter.attempts).toBe(300);
  expect(f.navigations.length + f.reads.length).toBe(300);
  expect(f.navigations.filter(url => url === `${CANVAS_ORIGIN}/courses`)).toHaveLength(1);
  expect(f.reads.filter(endpoint => endpoint === '/api/user')).toHaveLength(1);
  expect(f.data().sources).toMatchObject([{ source: 'canvas', status: 'completed', attempted: 296 }, { source: 'ed', status: 'capReached', attempted: 2 }]);
  expect(f.data().capReached).toBe(true);
});
it('foreground Ed still allows interactive capture through an eligible Canvas tab', async () => {
  const f = fixture(); await capture({ isTTY: true, crawl: true }, f.dependencies);
  expect(f.navigations).toHaveLength(5); expect(f.reads).toHaveLength(4);
});
it('second c and reselection are refused during a crawl while manual s remains available', async () => {
  let finish!: () => void; let signal!: AbortSignal;
  const runCapture = vi.fn(async (value: AbortSignal) => { signal = value; await new Promise<void>(resolve => { finish = resolve; }); });
  const page = { isClosed: () => false, evaluate: async () => true };
  const close = vi.fn(async () => {}); const save = vi.fn(async () => 'synthetic'); const log = vi.fn();
  async function* commands() { yield 'c'; yield 'c'; yield 'r'; yield 's'; yield 'q'; }
  const running = captureSession({ pages: () => [page], close }, commands(), save, log, { runCapture });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(runCapture).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('a crawl is already running');
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/reselection.*running/i));
  expect(close).not.toHaveBeenCalled(); finish(); await running; expect(close).toHaveBeenCalledTimes(1);
});
it.each(['q', 'browser-close', 'SIGINT', 'SIGTERM'] as const)('%s settles in-flight snapshot work before cleanup and releases the lock once', async event => {
  const f = fixture(); f.pauseSnapshot(); let stopping = false;
  const terminal = Object.assign(new EventEmitter(), { close: vi.fn(() => terminal.emit('close')), async *[Symbol.asyncIterator]() {
    yield 'c'; await vi.waitFor(() => expect(f.saves).toHaveLength(1));
    stopping = true;
    if (event === 'q') yield 'q';
    else { if (event === 'browser-close') f.context.emit('close'); else process.emit(event); }
  } });
  f.dependencies.terminal = () => terminal as never;
  const running = capture({ isTTY: true }, f.dependencies);
  await vi.waitFor(() => expect(stopping).toBe(true));
  expect(f.context.close).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  f.finishSnapshot(); await running; expect(f.context.close).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  const summary = JSON.parse((f.dependencies.stderr as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).data;
  expect(summary.sources).toMatchObject([{ source: 'canvas', status: 'aborted', saved: 1 }, { source: 'ed', status: 'aborted' }]);
  expect(f.navigations).toHaveLength(1);
  expect(f.reads).toHaveLength(0);
});

it('Canvas redirects and duplicate counts reach bounded summaries without query or fragment data', async () => {
  const f = fixture({ redirects: true }); await capture({ isTTY: false }, f.dependencies);
  expect(f.data().canvas).toMatchObject({ duplicates: 3, redirects: [
    { requestedUrl: `${CANVAS_ORIGIN}/courses/101/assignments`, finalUrl: `${CANVAS_ORIGIN}/courses/101`, alreadySaved: false },
    { requestedUrl: `${CANVAS_ORIGIN}/courses/101/announcements`, finalUrl: `${CANVAS_ORIGIN}/courses/101`, alreadySaved: true },
    { requestedUrl: `${CANVAS_ORIGIN}/courses/101/grades`, finalUrl: `${CANVAS_ORIGIN}/courses/101`, alreadySaved: true },
    { requestedUrl: `${CANVAS_ORIGIN}/courses/101/assignments/syllabus`, finalUrl: `${CANVAS_ORIGIN}/courses/101`, alreadySaved: true },
  ] });
  expect(JSON.stringify(f.data())).not.toMatch(/synthetic_secret|#private|<p>|Synthetic Course/);
});
it('interactive Canvas without an eligible tab reports notStarted while Ed completes', async () => {
  const f = fixture(); f.context.pages = () => [{ isClosed: () => false, url: () => `${ED_ORIGIN}/au/`, evaluate: async () => true }] as never;
  // Canvas does not create a crawl tab, so the first hidden page belongs to Ed.
  f.context.takePage();
  await capture({ isTTY: true, crawl: false, reselect: false }, { ...f.dependencies,
    terminal: () => Object.assign(new EventEmitter(), { close: vi.fn(), async *[Symbol.asyncIterator]() {
      yield 'c'; await vi.waitFor(() => expect(f.reads).toHaveLength(4)); await new Promise(resolve => setImmediate(resolve)); yield 'q';
    } }) as never,
  });
  expect(f.navigations).toEqual([]);
  expect((f.dependencies.stderr as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toContain('Open a Canvas course page');
});

it('expired Ed discovery during reselection retains its stored choice and lets Canvas complete', async () => {
  const f = fixture({ first: true, edExpired: true });
  f.dependencies.store!.load = async () => ({ status: 'valid', selection });
  await capture({ isTTY: true, crawl: true, reselect: true }, { ...f.dependencies,
    terminal: () => Object.assign(new EventEmitter(), { output: { write: vi.fn() }, question: async () => 'done', close: vi.fn(), async *[Symbol.asyncIterator]() {} }) as never,
  });
  expect(f.data().sources).toMatchObject([{ source: 'canvas', status: 'completed', saved: 4 }, { source: 'ed', status: 'authExpired', attempted: 0, error: { code: 'AUTH_EXPIRED' } }]);
  expect(f.reads).toEqual(['/api/user']);
  expect(f.navigations.filter(url => url === `${CANVAS_ORIGIN}/courses`)).toHaveLength(1);
});

it('persists one final private summary including both source outcomes', async () => {
  const f = fixture({ edExpired: true }); await capture({ isTTY: false }, f.dependencies);
  expect(f.summaries()).toHaveLength(1);
  expect(f.data()).toEqual(f.summaries()[0]);
  expect(f.summaries()[0]).toMatchObject({ attempted: 6, capReached: false, aborted: false,
    sources: [{ source: 'canvas', saved: 5 }, { source: 'ed', status: 'authExpired' }] });
  expect(JSON.stringify(f.summaries())).not.toMatch(/<p>|Synthetic Course|synthetic_secret/);
});
it('first selection saves Canvas discovery once without another navigation', async () => {
  const f = fixture({ first: true }); await capture({ isTTY: true, crawl: true }, f.dependencies);
  expect(f.saves.filter(url => url === `${CANVAS_ORIGIN}/courses`)).toHaveLength(1);
  expect(f.navigations.filter(url => url === `${CANVAS_ORIGIN}/courses`)).toHaveLength(1);
});

it('persists sanitized Canvas failed URLs in the final summary', async () => {
  const f = fixture({ canvasFailure: true }); await capture({ isTTY: false }, f.dependencies);
  expect(f.summaries()[0]).toMatchObject({ failed: 1, failedUrls: [`${CANVAS_ORIGIN}/courses/101/grades`] });
});
it('Ed-only runs also persist a final per-source summary', async () => {
  const f = fixture(); f.dependencies.store!.load = async () => ({ status: 'valid', selection: { version: 1, courses: [selection.courses[1]] } });
  f.context.takePage(); await capture({ isTTY: false }, f.dependencies);
  expect(f.summaries()).toHaveLength(1);
  expect(f.summaries()[0]).toMatchObject({ attempted: 4, saved: 4, status: 'completed', sources: [{ source: 'canvas', saved: 0 }, { source: 'ed', saved: 4 }] });
});
