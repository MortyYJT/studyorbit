import { join } from 'node:path';
import type { CaptureBrowser } from './browser.js';

export interface CapturePage {
  isClosed(): boolean;
  evaluate(expression: string): Promise<boolean>;
}
export interface CaptureContext<P extends CapturePage> {
  pages(): P[];
  close(): Promise<void>;
}
export function prepareCommands(commands: AsyncIterable<string>): AsyncIterable<string> {
  // Subscribe before launch so an early terminal close is retained by the iterator.
  const iterator = commands[Symbol.asyncIterator]();
  return { [Symbol.asyncIterator]: () => iterator };
}
export async function confirmBundledBrowser(
  terminal: { question(prompt: string, options: { signal: AbortSignal }): Promise<string> },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  try {
    const answer = await terminal.question('Edge and Chrome are unavailable. Use installed bundled Chromium? [y/N] ', { signal });
    return /^y(es)?$/i.test(answer.trim());
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  }
}
export function launchSettings(home: string, browser: CaptureBrowser) {
  return { profile: join(home, 'profiles', 'default'), options: { headless: false, handleSIGINT: false, handleSIGTERM: false, ...(browser === 'chromium' ? {} : { channel: browser }) } };
}

export async function activePage<P extends CapturePage>(context: Pick<CaptureContext<P>, 'pages'>): Promise<P | undefined> {
  const pages = context.pages().filter(page => !page.isClosed());
  // Terminal focus can make hasFocus false; visibility still identifies the selected tab.
  for (const expression of ['document.hasFocus()', 'document.visibilityState === "visible"']) {
    for (const page of [...pages].reverse()) {
      try { if (await page.evaluate(expression)) return page; }
      catch { /* A tab can close or navigate while it is being selected. */ }
    }
  }
  return pages.at(-1);
}

export async function captureSession<P extends CapturePage>(
  context: CaptureContext<P>, commands: AsyncIterable<string>,
  save: (page: P) => Promise<string>, log: (message: string) => void,
  options: { runCapture?: (signal: AbortSignal) => Promise<unknown>; crawl?: (page: P, signal: AbortSignal) => Promise<unknown>; signal?: AbortSignal } = {},
): Promise<void> {
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  let crawling: Promise<void> | undefined;
  try {
    log('Sign in and navigate by hand. Enter s to save the active tab, c to capture selected courses, q to quit.');
    for await (const line of commands) {
      const command = line.trim().toLowerCase();
      if (command === 'q' || cancellation.signal.aborted) break;
      if (command === 'c') {
        if (crawling) { log('a crawl is already running'); continue; }
        if (options.runCapture) {
          crawling = Promise.resolve().then(() => options.runCapture!(cancellation.signal))
            .then(() => {}, () => { log('Unable to complete the capture.'); })
            .finally(() => { crawling = undefined; });
          continue;
        }
        const page = await activePage(context);
        if (!page) { log('Open a Canvas course page first.'); continue; }
        crawling = Promise.resolve().then(() => options.crawl?.(page, cancellation.signal))
          .then(() => {}, () => { log('Unable to complete the crawl.'); })
          .finally(() => { crawling = undefined; });
        continue;
      }
      if (command !== 's') { log('Enter s to save, c to capture selected courses, or q to quit.'); continue; }
      const page = await activePage(context);
      if (!page) { log('No open page to save.'); continue; }
      try { log(`Saved snapshot: ${await save(page)}`); }
      catch { log('Unable to save this page; try again after it finishes loading.'); }
    }
  } finally {
    stop();
    await crawling;
    options.signal?.removeEventListener('abort', stop);
    await context.close();
  }
}
