import { afterEach, expect, it, vi } from 'vitest';
import { PlaywrightToolPage, submissionControl, visibleText } from '../../src/browser/tools/playwright.js';
import type { Page } from 'playwright';
// Minimal synthetic DOM boundary: exercise our projection, not a DOM library.
class Element {
  nodeType = 1;
  style = { display: 'block', visibility: 'visible', opacity: '1' };
  childNodes: (Element | { nodeType: number; textContent: string })[] = [];
  constructor(readonly tagName: string, readonly selectors: string[] = [], readonly textContent = '') {}
  matches(selector: string) { return selector.split(',').some(s => s.toUpperCase() === this.tagName || this.selectors.includes(s)); }
  closest() { return null; }
  getAttribute() { return null; }
}
afterEach(() => vi.unstubAllGlobals());
it('11.2 rendered projection excludes hidden values, credentials, scripts and peer answers', () => {
  vi.stubGlobal('Element', Element); vi.stubGlobal('getComputedStyle', (e: Element) => e.style);
  const text = (value: string) => ({ nodeType: 3, textContent: value });
  const root = new Element('BODY'); const question = new Element('P'); question.childNodes = [text('Question 12345678')];
  const cssHidden = new Element('DIV'); cssHidden.style.display = 'none'; cssHidden.childNodes = [text('hidden solution')];
  const peer = new Element('DIV', ['.peer-answers']); peer.childNodes = [text('Peer Fixture answer')];
  const script = new Element('SCRIPT'); script.childNodes = [text('token=private')];
  const input = new Element('INPUT'); input.childNodes = [text('hidden form value')];
  const textarea = new Element('TEXTAREA'); textarea.childNodes = [text('answer value')];
  root.childNodes = [question, cssHidden, peer, script, input, textarea];
  expect(visibleText(root as unknown as globalThis.Element)).toMatch(/^Question 12345678\s+\[redacted\]\s*$/);
});
it('11.4 reclassifies implicit submit buttons at action time and never clicks via browser.click', async () => {
  vi.stubGlobal('Element', Element); vi.stubGlobal('getComputedStyle', (e: Element) => e.style);
  const click = vi.fn(); let submit = false;
  const node = Object.assign(new Element('BUTTON', [], 'Continue'), { type: 'submit', form: {} });
  expect(submissionControl(node as unknown as Node)).toBe(true);
  expect(submissionControl({ ...node, tagName: 'INPUT', type: 'image' } as unknown as Node)).toBe(true);
  const handle = { isVisible: async () => true, evaluate: async (fn: Function, arg?: unknown) => fn(Object.assign(node, { form: submit ? {} : null, type: submit ? 'submit' : 'button' }), arg), click };
  const page = { locator: (selector: string) => selector === 'body' ? { evaluate: async () => 'Synthetic' } : selector.includes('.author') ? { evaluateAll: async () => [] } : { elementHandles: async () => [handle] } };
  const adapter = new PlaywrightToolPage(page as unknown as Page);
  const snapshot = await adapter.read(); submit = true;
  await expect(adapter.act('click', snapshot.targets[0]!.ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(click).not.toHaveBeenCalled(); await adapter.act('submit', snapshot.targets[0]!.ref); expect(click).toHaveBeenCalledOnce();
});
it('11.1 refuses login redirects before navigation and never types credentials', async () => {
  let routeHandler!: Function; const page = { route: async (_pattern: string, handler: Function) => { routeHandler = handler; }, on: () => {} };
  const adapter = new PlaywrightToolPage(page as unknown as Page); await adapter.guard();
  const abort = vi.fn(); const proceed = vi.fn();
  await routeHandler({ request: () => ({ isNavigationRequest: () => true, url: () => 'https://sso.invalid/login' }), abort, continue: proceed });
  expect(abort).toHaveBeenCalledOnce(); expect(proceed).not.toHaveBeenCalled();
  await expect(adapter.signedOut()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
});
it('11.2 references remain stable for the same rendered element across reads', async () => {
  vi.stubGlobal('Element', Element); vi.stubGlobal('getComputedStyle', (e: Element) => e.style);
  const node = new Element('BUTTON');
  const handle = { isVisible: async () => true, evaluate: async (fn: Function, arg?: unknown) => fn(node, arg === handle ? node : arg) };
  const page = { locator: (selector: string) => selector === 'body' ? { evaluate: async () => 'Synthetic' } : selector.includes('.author') ? { evaluateAll: async () => [] } : { elementHandles: async () => [handle] } };
  const adapter = new PlaywrightToolPage(page as unknown as Page);
  const first = await adapter.read(); const second = await adapter.read(); expect(second.targets[0]!.ref).toBe(first.targets[0]!.ref);
});
it('11.2 describes form targets with public labels while withholding answer values and hidden labels', () => {
  vi.stubGlobal('Element', Element); vi.stubGlobal('getComputedStyle', (e: Element) => e.style);
  const label = new Element('LABEL'); label.childNodes = [{ nodeType: 3, textContent: 'Question one' }];
  const hidden = new Element('LABEL'); hidden.style.display = 'none'; hidden.childNodes = [{ nodeType: 3, textContent: 'hidden solution' }];
  const input = Object.assign(new Element('INPUT'), { labels: [label, hidden], value: 'private answer' });
  expect(visibleText(input as unknown as globalThis.Element).trim()).toBe('Question one');
  const textarea = Object.assign(new Element('TEXTAREA'), {
    getAttribute: (name: string) => name === 'aria-label' ? 'Question two' : null, value: 'private essay',
  });
  expect(visibleText(textarea as unknown as globalThis.Element)).toBe('Question two');
  const select = Object.assign(new Element('SELECT'), { labels: [label], value: 'hidden-option-id' });
  expect(visibleText(select as unknown as globalThis.Element).trim()).toBe('Question one');
});
