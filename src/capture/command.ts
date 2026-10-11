import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { dataDir } from '../config/data-dir.js';
import { fail, ok, type Envelope } from '../protocol/envelope.js';
import { CourseworkError } from '../protocol/errors.js';
import { acquireProfileLock } from './lock.js';
import { chooseBrowser, isBrowserInstalled, recordBrowser, type CaptureBrowser } from './browser.js';
import { openHiddenPage } from './tab.js';
import { saveSnapshot } from './snapshot.js';
import { activePage, captureSession, launchSettings, prepareCommands, confirmBundledBrowser } from './session.js';
import { CANVAS_ORIGIN, unavailable, type DiscoveryResult } from './discovery.js';
import { discoverCanvas, discoverEd } from './discovery-adapters.js';
import { RequestLimiter, type CaptureLimiter } from './limiter.js';
import { SelectionStore, type CaptureSelection, type SelectionPersistence } from './selection-store.js';
import { resolveSelection, type SelectionResolution } from './selection-resolver.js';
import { EdTransport, safeEdEndpoint } from './ed-transport.js';
import { runEdCapture, type EdOutcome, type EdReader } from './ed-capture.js';
import { writeEdSnapshot } from './ed-snapshot.js';

export interface CanvasOutcome {
  source: 'canvas'; status: 'completed' | 'partial' | 'signedOut' | 'capReached' | 'aborted' | 'notStarted';
  attempted: number; saved: number; failed: number; skipped: number;
  error?: { code: 'SOURCE_UNAVAILABLE' | 'AUTH_EXPIRED'; next?: string };
}
export interface CanvasRunInput {
  context: BrowserContext; active?: Page; selection: CaptureSelection; discovery?: DiscoveryResult[];
  discoveryPage?: Page; limiter: CaptureLimiter; signal: AbortSignal; save: typeof saveSnapshot;
}
export type CanvasRunner = (input: CanvasRunInput) => Promise<CanvasOutcome>;
export interface EdRunInput {
  courses: CaptureSelection['courses']; transport: EdReader; snapshot: (endpoint: string, body: unknown, status: number) => Promise<void>; discoveryCaptured?: boolean;
  limiter: CaptureLimiter; signal: AbortSignal;
}
export interface CaptureDependencies {
  store?: SelectionPersistence; limiter?: () => CaptureLimiter;
  acquireLock?: () => () => void;
  terminal?: () => Interface;
  chooseBrowser?: typeof chooseBrowser;
  launch?: typeof chromium.launchPersistentContext;
  canvasRunner?: CanvasRunner;
  edRunner?: (input: EdRunInput) => Promise<EdOutcome>;
  discover?: (limiter: CaptureLimiter, signal: AbortSignal) => Promise<DiscoveryResult[]>;
  stdout?: (message: string) => void; stderr?: (message: string) => void;
}
export interface CaptureOptions { crawl?: boolean; reselect?: boolean; isTTY?: boolean }
const emptyCanvas = (): CanvasOutcome => ({ source: 'canvas', status: 'notStarted', attempted: 0, saved: 0, failed: 0, skipped: 0,
  error: { code: 'SOURCE_UNAVAILABLE', next: 'Selected Canvas runner awaits issue B integration.' } });
const emptyEd = (): EdOutcome => ({ source: 'ed', status: 'notStarted', attempted: 0, saved: 0, failed: 0, skipped: 0, gaps: [] });
/** The Canvas runner is injected until issue B merges; never fall back to the unselected legacy crawl. */
export async function capture(options: CaptureOptions = {}, dependencies: CaptureDependencies = {}): Promise<void> {
  const isTTY = options.isTTY ?? Boolean(stdin.isTTY && stdout.isTTY);
  const output = dependencies.stdout ?? (message => console.log(message));
  const log = dependencies.stderr ?? (message => console.error(message));
  const store = dependencies.store ?? new SelectionStore();
  const cancellation = new AbortController();
  let release: (() => void) | undefined;
  let terminal: Interface | undefined;
  let context: BrowserContext | undefined;
  let result: Envelope | undefined;
  const hidden = new Set<Page>();
  const stop = () => { cancellation.abort(); terminal?.close(); };
  const terminalWrite = (message: string) => terminal!.write(message + '\n');
  try {
    // Resolver preflight must precede even the profile lock and browser detection without a TTY.
    let preflight: SelectionResolution | undefined;
    if (!isTTY) {
      preflight = await resolveSelection({ isTTY: false, reselect: options.reselect, store, discover: async () => [] });
      if (preflight.status === 'error') { result = preflight.envelope; return; }
    }
    release = (dependencies.acquireLock ?? acquireProfileLock)();
    if (isTTY) {
      terminal = (dependencies.terminal ?? (() => createInterface({ input: stdin, output: stdout })))();
      terminal.once('close', stop); terminal.on('SIGINT', stop);
    }
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const home = dataDir();
    const profile = join(home, 'profiles', 'default');
    const browser: CaptureBrowser = await (dependencies.chooseBrowser ?? chooseBrowser)({
      profile, override: process.env.COURSEWORK_BROWSER,
      isInstalled: browser => isBrowserInstalled(browser, chromium.executablePath()), isTTY,
      confirm: () => terminal ? confirmBundledBrowser(terminal, cancellation.signal) : Promise.resolve(false),
    });
    if (cancellation.signal.aborted) return;
    const settings = launchSettings(home, browser);
    context = await (dependencies.launch ?? chromium.launchPersistentContext.bind(chromium))(settings.profile, settings.options);
    recordBrowser(profile, browser);
    context.once('close', stop);
    if (cancellation.signal.aborted) return;
    const sessionContext = { pages: () => context!.pages().filter(page => !hidden.has(page)), close: async () => {} };
    type RunState = { limiter: CaptureLimiter; resolution: SelectionResolution; canvasPage?: Page; edPage?: Page };
    const newState = (): RunState => ({ limiter: dependencies.limiter?.() ?? new RequestLimiter(), resolution: { status: 'cancelled' } });
    const hiddenPage = async (): Promise<Page | undefined> => {
      const anchor = await activePage(sessionContext);
      if (!anchor) return undefined;
      const page = await openHiddenPage(context!, anchor); hidden.add(page); return page;
    };
    const snapshot = async (endpoint: string, body: unknown, status: number) => { await writeEdSnapshot(endpoint, body, status, home); };
    const resolve = async (state: RunState, reselect: boolean, signal: AbortSignal) => {
      state.resolution = await resolveSelection({ isTTY, reselect, store, signal,
        terminal: terminal ? { write: terminalWrite, question: (prompt, opts) => terminal!.question(prompt, opts ?? {}) } : undefined,
        discover: async () => {
          if (dependencies.discover) return dependencies.discover(state.limiter, signal);
          const active = await activePage(sessionContext);
          let canvas: DiscoveryResult = unavailable('canvas');
          if (active?.url().startsWith(`${CANVAS_ORIGIN}/courses`)) {
            state.canvasPage = await hiddenPage();
            if (state.canvasPage) canvas = await discoverCanvas(state.canvasPage, state.limiter, signal);
          }
          state.edPage = await hiddenPage();
          const ed = state.edPage ? await discoverEd(state.edPage, state.limiter, { signal, snapshot: courses => snapshot('/api/user', courses, 200) }) : unavailable('ed');
          return [canvas, ed];
        },
      });
    };
    const closeHidden = async () => {
      for (const page of hidden) { await page.close().catch(() => {}); hidden.delete(page); }
    };
    let pending: RunState | undefined;
    if (options.reselect) {
      pending = newState(); await resolve(pending, true, cancellation.signal);
      if (pending.resolution.status !== 'ready') { await closeHidden(); return; }
    }
    const execute = async (signal: AbortSignal): Promise<Envelope | undefined> => {
      const state = pending ?? newState(); pending = undefined;
      try {
        if (preflight) { state.resolution = preflight; preflight = undefined; }
        else if (state.resolution.status !== 'ready') await resolve(state, false, signal);
        if (state.resolution.status === 'error') return state.resolution.envelope;
        if (state.resolution.status !== 'ready') return undefined;
        const { selection, discovery } = state.resolution;
        let canvas = emptyCanvas(); let ed = emptyEd();
        if (!selection.courses.some(course => course.source === 'canvas')) { canvas.status = 'completed'; delete canvas.error; }
        else if (dependencies.canvasRunner) canvas = await dependencies.canvasRunner({ context: context!, active: await activePage(sessionContext), selection, discovery,
          discoveryPage: state.canvasPage, limiter: state.limiter, signal, save: saveSnapshot });
        if (!selection.courses.some(course => course.source === 'ed')) ed.status = 'completed';
        else {
          const edDiscovery = discovery?.find(source => source.source === 'ed');
          if (edDiscovery?.status === 'unavailable') {
            ed.status = edDiscovery.error.code === 'AUTH_EXPIRED' ? 'authExpired' : 'partial';
            if (ed.status === 'authExpired') ed.error = { code: 'AUTH_EXPIRED', next: 'Ask the user to sign in to Ed again.' };
          } else {
            // Injected fake runners need no browser page; production Ed always uses a hidden page.
            state.edPage ??= dependencies.edRunner ? undefined : await hiddenPage();
            if (state.edPage || dependencies.edRunner) ed = await (dependencies.edRunner ?? runEdCapture)({ courses: selection.courses,
              transport: state.edPage ? new EdTransport(state.edPage, state.limiter, signal) : { read: async () => ({ kind: 'gap', reason: 'unavailable' }) },
              snapshot, discoveryCaptured: edDiscovery?.status === 'available', limiter: state.limiter, signal });
          }
        }
        // Project counts/status only: a runner cannot accidentally expose its raw payload or private paths.
        const counts = (source: CanvasOutcome | EdOutcome) => ({ source: source.source, status: source.status,
          attempted: source.attempted, saved: source.saved, failed: source.failed, skipped: source.skipped,
          ...(source.error ? { error: { code: source.error.code, next: source.error.code === 'AUTH_EXPIRED' ? 'Ask the user to sign in again.' : 'Source unavailable.' } } : {}) });
        const edGaps = ed.gaps.filter(gap => safeEdEndpoint(gap.endpoint)).slice(0, 30).map(gap => ({
          endpoint: gap.endpoint, ...(Number.isInteger(gap.status) ? { status: gap.status } : {}),
          reason: ['unsafeEndpoint', 'unavailable', 'http', 'invalidJson', 'snapshot', 'invalidShape', 'auth'].includes(gap.reason) ? gap.reason : 'unavailable',
        }));
        return ok('capture', { attempted: state.limiter.attempts, sources: [counts(canvas), counts(ed)],
          edGaps, edGapsOmitted: ed.gaps.length - edGaps.length,
          discoveryGaps: state.resolution.gaps.map(gap => ({ source: gap.source, code: gap.status === 'unavailable' ? gap.error.code : 'SOURCE_UNAVAILABLE' })),
          missing: state.resolution.missing.length });
      } finally { await closeHidden(); }
    };
    if (options.crawl || !isTTY) result = await execute(cancellation.signal);
    else await captureSession(sessionContext, prepareCommands(terminal!), saveSnapshot, log, {
      signal: cancellation.signal, runCapture: async signal => {
        const envelope = await execute(signal);
        if (envelope) log(JSON.stringify(envelope));
      },
    });
  } catch (error) {
    if (isTTY) throw error;
    const code = error instanceof CourseworkError ? error.code : 'SOURCE_UNAVAILABLE';
    result = fail('capture', code, code === 'LOCKED' ? 'Browser profile is locked.' : 'Capture could not complete.',
      'Run capture in a terminal to check selection, browser and sign-in.');
  } finally {
    cancellation.abort(); terminal?.close();
    try {
      for (const page of hidden) await page.close().catch(() => {});
      await context?.close();
    } catch { if (!isTTY && !result) result = fail('capture', 'SOURCE_UNAVAILABLE', 'Browser cleanup failed.'); }
    finally {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      terminal?.removeListener('SIGINT', stop); release?.();
      if (!isTTY) output(JSON.stringify(result ?? fail('capture', 'SOURCE_UNAVAILABLE', 'Capture was cancelled.')));
      else if (result) log(JSON.stringify(result));
    }
  }
}
