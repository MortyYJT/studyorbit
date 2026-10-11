import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { chooseBrowser, recordBrowser, isBrowserInstalled } from '../../capture/browser.js';
import { acquireProfileLock } from '../../capture/lock.js';
import { activePage, launchSettings } from '../../capture/session.js';
import { openHiddenPage } from '../../capture/tab.js';
import { EdTransport } from '../../capture/ed-transport.js';
import { RequestLimiter } from '../../capture/limiter.js';
import { dataDir } from '../../config/data-dir.js';
import { CourseworkError } from '../../protocol/errors.js';
import type { QuizTarget } from './contracts.js';
import type { QuizSession } from './command.js';
export interface ManagedQuizDependencies { verifyPrerequisites?: (target: QuizTarget) => Promise<void>; acquireLock?: () => () => void;
  chooseBrowser?: typeof chooseBrowser; recordBrowser?: typeof recordBrowser; launch?: typeof chromium.launchPersistentContext; openHiddenPage?: typeof openHiddenPage }
export async function openManagedQuizSession(target: QuizTarget, dependencies: ManagedQuizDependencies = {}): Promise<QuizSession> {
  // Issue B owns actual-course policy/private-repository verification. No live bypass flag.
  if (!dependencies.verifyPrerequisites) throw new CourseworkError('INVALID_INPUT', 'Real quiz prerequisites require issue B integration.');
  await dependencies.verifyPrerequisites(target);
  const release = (dependencies.acquireLock ?? acquireProfileLock)();
  let context: BrowserContext | undefined; let closing: Promise<void> | undefined;
  const cancellation = new AbortController();
  const stop = () => {
    cancellation.abort();
    // Closing the context interrupts a pending page evaluate/fetch; abort alone cannot.
    if (context) void close().catch(() => {});
  };
  const close = (): Promise<void> => closing ??= Promise.resolve().then(async () => {
    cancellation.abort();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { await context?.close(); } finally { release(); }
  });
  try {
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const home = dataDir(); const profile = join(home, 'profiles', 'default');
    const browser = await (dependencies.chooseBrowser ?? chooseBrowser)({ profile, override: process.env.COURSEWORK_BROWSER,
      isInstalled: b => isBrowserInstalled(b, chromium.executablePath()), isTTY: false, confirm: async () => false });
    const settings = launchSettings(home, browser);
    if (cancellation.signal.aborted) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Quiz read cancelled.');
    context = await (dependencies.launch ?? chromium.launchPersistentContext.bind(chromium))(settings.profile, { ...settings.options, serviceWorkers: 'block' });
    if (cancellation.signal.aborted) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Quiz read cancelled.');
    (dependencies.recordBrowser ?? recordBrowser)(profile, browser);
    context.once?.('close', stop);
    const active = await activePage(context);
    if (!active) throw new CourseworkError('AUTH_EXPIRED', 'Managed session is unavailable.');
    const page = await (dependencies.openHiddenPage ?? openHiddenPage)(context, active);
    return { transport: new EdTransport(page, new RequestLimiter(), cancellation.signal), close };
  } catch (error) { await close(); throw error; }
}
