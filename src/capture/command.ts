import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { dataDir } from '../config/data-dir.js';
import { acquireProfileLock } from './lock.js';
import { chooseBrowser, isBrowserInstalled, recordBrowser } from './browser.js';
import { runCrawl } from './crawl.js';
import { openHiddenPage } from './tab.js';
import { saveSnapshot } from './snapshot.js';
import { captureSession, launchSettings, prepareCommands, confirmBundledBrowser } from './session.js';

export async function capture(): Promise<void> {
  const release = acquireProfileLock();
  const terminal = createInterface({ input: stdin, output: stdout });
  const commands = prepareCommands(terminal);
  const cancellation = new AbortController();
  terminal.once('close', () => cancellation.abort());
  let context: BrowserContext | undefined;
  const stop = () => { cancellation.abort(); terminal.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  terminal.on('SIGINT', stop);
  try {
    const home = dataDir();
    const profile = join(home, 'profiles', 'default');
    const browser = await chooseBrowser({
      profile, override: process.env.COURSEWORK_BROWSER,
      isInstalled: browser => isBrowserInstalled(browser, chromium.executablePath()),
      isTTY: Boolean(stdin.isTTY && stdout.isTTY),
      confirm: () => confirmBundledBrowser(terminal, cancellation.signal),
    });
    if (cancellation.signal.aborted) return;
    const settings = launchSettings(home, browser);
    context = await chromium.launchPersistentContext(settings.profile, settings.options);
    recordBrowser(profile, browser);
    if (cancellation.signal.aborted) return;
    context.once('close', stop);
    let crawlTab: Page | undefined;
    const sessionContext = {
      pages: () => context!.pages().filter(page => page !== crawlTab),
      close: () => context!.close(),
    };
    await captureSession(sessionContext, commands, saveSnapshot, console.log, {
      signal: cancellation.signal,
      crawl: (active, signal) => runCrawl({ openHiddenPage: () => openHiddenPage(context!, active) }, active.url(), {
        save: saveSnapshot, signal, log: console.log, onTab: page => { crawlTab = page; },
      }),
    });
  } finally {
    terminal.close();
    try { await context?.close(); }
    finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      terminal.removeListener('SIGINT', stop);
      release();
    }
  }
}
