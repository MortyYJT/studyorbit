import { ToolTabRecords } from './tab-records.js';
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type ElementHandle, type Page } from 'playwright';
import { screenshotsDir } from '../../config/data-dir.js';
import { CourseworkError } from '../../protocol/errors.js';
import { ResidentBrowser } from '../resident.js';
import { browserURL, discussion } from './url.js';
import type { PageSnapshot, ToolBrowser, ToolPage } from './ports.js';

const sensitive = 'input[type=password],input[autocomplete=one-time-code],input[name*=otp i],input[name*=password i]';
const peers = '.peer-answers,.peer-response,.student-response,[data-peer-answer],[data-peer-answers]';
const people = '.author,[data-author],[data-author-name],[rel=author],[itemprop=author],.user-name,.student-name';
/** Runs in the page, projecting rendered text only; never serializes markup or form values. */
export function visibleText(root: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const style = getComputedStyle(node);
    if (node.matches('script,style,noscript,iframe,input,textarea,select,[hidden],[aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return '';
    if (node.matches('.peer-answers,.peer-response,.student-response,[data-peer-answer],[data-peer-answers]')) return '[redacted]';
    return Array.from(node.childNodes).map(walk).join(' ').slice(0, 100000);
  };
  // Form values stay private, while public labels identify answer fields in the target list.
  if (root.matches('input,textarea,select')) {
    const label = root.getAttribute('aria-label')
      || Array.from((root as HTMLInputElement).labels ?? []).map(walk).join(' ').trim()
      || root.getAttribute('placeholder') || '';
    return label.slice(0, 100000);
  }
  return walk(root).slice(0, 100000);
}

/** Includes implicit form submit buttons and provider-style JS submission controls. */
export function submissionControl(node: Node): boolean {
  const e = node as HTMLInputElement | HTMLButtonElement;
  return e.tagName === 'INPUT' && /^(submit|image)$/i.test(e.type)
    || e.tagName === 'BUTTON' && !!e.form && e.type === 'submit'
    || /submit|hand[ -]?in|finish\s+(?:quiz|attempt|test)|提交|交卷/i.test(`${e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('name') ?? ''}`);
}

export class PlaywrightToolPage implements ToolPage {
  private readonly targets = new Map<string, ElementHandle<HTMLElement | SVGElement>>();
  private blocked?: CourseworkError;
  constructor(private readonly page: Page, private readonly dispose: () => Promise<void> = async () => {}) {}
  async guard(): Promise<void> {
    // A disallowed document is aborted before it can execute or receive a form submission.
    await this.page.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest()) return route.continue();
      try { browserURL(request.url()); }
      catch (error) { this.blocked = error as CourseworkError; await route.abort(); return; }
      await route.continue();
    });
    this.page.on('framenavigated', frame => { if (frame === this.page.mainFrame()) this.targets.clear(); });
  }
  async navigate(url: string): Promise<void> {
    try { await this.page.goto(url, { waitUntil: 'domcontentloaded' }); }
    catch (error) { if (this.blocked) throw this.blocked; throw error; }
  }
  url(): string { return this.page.url(); }
  async signedOut(): Promise<boolean> {
    if (this.blocked) throw this.blocked;
    return await this.page.locator(sensitive).count() > 0;
  }
  async read(): Promise<PageSnapshot> {
    const previous = [...this.targets]; this.targets.clear();
    const text = await this.page.locator('body').evaluate(visibleText);
    const names = await this.page.locator(people).evaluateAll(elements => elements.map(e => e.getAttribute('data-author-name') ?? e.getAttribute('data-author') ?? e.textContent ?? '').filter(Boolean));
    const targets: PageSnapshot['targets'] = [];
    for (const handle of await this.page.locator('a,button,input,textarea,select,[role=button],[role=checkbox],[role=radio],[contenteditable=true]').elementHandles()) {
      if (targets.length >= 50) break;
      if (!await handle.isVisible() || await handle.evaluate((e, selectors) => !!(e as Element).closest(selectors), `${sensitive},${peers},[hidden],[aria-hidden=true]`)) continue;
      const kind = await handle.evaluate(submissionControl) ? 'submit' : await handle.evaluate(e => (e as Element).tagName.toLowerCase());
      // Text/labels are projected by the same visible-only function, without input values.
      const label = await handle.evaluate(visibleText);
      let ref: string | undefined;
      for (const [id, old] of previous) {
        try { if (await old.evaluate((element, current) => element === current, handle)) { ref = id; break; } } catch { /* Navigation invalidates old handles. */ }
      }
      ref ??= randomUUID(); this.targets.set(ref, handle as ElementHandle<HTMLElement | SVGElement>);
      targets.push({ ref, kind, description: label.trim().slice(0, 200) || kind });
    }
    await Promise.allSettled(previous.filter(([, old]) => ![...this.targets.values()].includes(old)).map(([, old]) => old.dispose()));
    return { text, targets, people: names, peers: [] };
  }
  private target(ref: string) {
    const handle = this.targets.get(ref);
    if (!handle) throw new CourseworkError('INVALID_INPUT', 'Read the visible target before acting.');
    return handle;
  }
  async front() { await this.page.bringToFront(); }
  async highlight(ref: string) { await this.target(ref).evaluate(e => { e.style.outline = '2px solid red'; }); }
  async isVisible(ref: string) {
    const handle = this.targets.get(ref);
    return !!handle && await handle.isVisible() && !await handle.evaluate((e, selectors) => !!(e as Element).closest(selectors), `${sensitive},${peers},[hidden],[aria-hidden=true]`);
  }
  async act(action: 'click' | 'fill' | 'select' | 'submit', ref: string, value?: string) {
    const handle = this.target(ref);
    if (action !== 'submit' && await handle.evaluate(submissionControl)) throw new CourseworkError('INVALID_INPUT', 'Use browser.submit for submission controls.');
    // Element handles bind identity. No selector re-resolution or application-level retry.
    if (action === 'click' || action === 'submit') await handle.click({ timeout: 2000, noWaitAfter: true });
    else if (action === 'fill') await handle.fill(value!, { timeout: 2000 });
    else await handle.selectOption(value!, { timeout: 2000 });
  }
  async screenshot(): Promise<string> {
    browserURL(this.url());
    if (discussion(new URL(this.url()))) throw new CourseworkError('INVALID_INPUT', 'Discussion screenshots are refused.');
    const ref = randomUUID(); const path = join(screenshotsDir(), `${ref}.png`);
    const bytes = await this.page.screenshot({ type: 'png', mask: [this.page.locator(`${sensitive},${peers},${people}`)] });
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' }); chmodSync(path, 0o600);
    return ref;
  }
  async close() { try { await this.page.close(); } finally { await this.dispose(); } }
}
/** Lazily connects, owns only newly created tabs, and disconnects without stopping the resident. */
export class ResidentToolBrowser implements ToolBrowser {
  private connection?: Promise<Browser>;
  private closed = false;
  private async connect(): Promise<Browser> {
    if (this.closed) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Browser tools are closed.');
    if (!this.connection) this.connection = (async () => {
      const state = new ResidentBrowser().current();
      if (!state) throw new CourseworkError('AUTH_EXPIRED', 'Start the resident browser and sign in by hand.');
      return chromium.connectOverCDP(state.endpoint, { noDefaults: true });
    })().catch(error => { this.connection = undefined; throw error; });
    return this.connection;
  }
  async newPage(tabId = randomUUID()): Promise<ToolPage> {
    const browser = await this.connect(); const context = browser.contexts()[0];
    if (!context) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Resident browser context unavailable.');
    const raw = await context.newPage();
    const records = new ToolTabRecords();
    try {
      const session = await context.newCDPSession(raw);
      try { const { targetInfo } = await session.send('Target.getTargetInfo'); await records.save(tabId, targetInfo.targetId); }
      finally { await session.detach(); }
      const page = new PlaywrightToolPage(raw, () => records.remove(tabId)); await page.guard(); return page;
    } catch (error) { await raw.close(); await records.remove(tabId); throw error; }
  }
  async focus(tabId: string) {
    const targetId = await new ToolTabRecords().load(tabId);
    const session = await (await this.connect()).newBrowserCDPSession();
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo', { targetId });
      browserURL(targetInfo.url);
      await session.send('Target.activateTarget', { targetId });
    } finally { await session.detach(); }
  }
  async close() { this.closed = true; if (this.connection) await (await this.connection).close(); }
}
