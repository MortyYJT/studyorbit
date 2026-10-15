import { expect, it, vi } from 'vitest';
import { bringSignInToFront } from '../../src/browser/signin.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { httpCommandContext } from '../../src/protocol/http.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';

function page(initial: string) {
  let url = initial;
  return { url: () => url, goto: vi.fn(async (target: string) => { url = target; }), bringToFront: vi.fn(async () => {}) };
}
function setup(urls: string[]) {
  const pages = urls.map(page);
  const newPage = vi.fn(async () => { const created = page('about:blank'); pages.push(created); return created; });
  const disconnect = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ contexts: () => [{ pages: () => pages, newPage }], close: disconnect }));
  const resident = { current: () => ({ endpoint: 'http://127.0.0.1:43210', pid: 12345, browser: 'msedge' as const, startedAt: '2026-01-01T00:00:00.000Z' }) };
  return { pages, newPage, disconnect, connect, resident };
}

it('11.6 refuses a non-TTY caller without an owner session before touching any tab', async () => {
  const s = setup(['https://edstem.org/au/login']);
  const signin = vi.fn((site: 'canvas' | 'ed') => bringSignInToFront(site, s));
  const registry = createRegistry({ browser: { signin } });
  const context = createFakeContext({ owner: true });
  expect(await dispatch(registry, 'browser.signin', { site: 'ed' }, httpCommandContext(context, 'browser.signin', false, () => false)))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  const output: string[] = [];
  await parseProtocolCLI(['browser', 'signin', '--site', 'ed'], { registry, context, isTTY: false, stdout: line => output.push(line), stderr: () => {} });
  expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(signin).not.toHaveBeenCalled(); expect(s.connect).not.toHaveBeenCalled();
});

it('11.6 owner session focuses an existing site sign-in tab without opening or navigating tabs', async () => {
  for (const [site, url] of [['canvas', 'https://canvas.lms.unimelb.edu.au/login/saml'], ['ed', 'https://edstem.org/au/login?next=private']] as const) {
    const s = setup(['https://example.invalid/login', url, 'https://edstem.org/au/courses/1']);
    const registry = createRegistry({ browser: { signin: target => bringSignInToFront(target, s) } });
    const context = httpCommandContext(createFakeContext({ owner: true }), 'browser.signin', true, () => false);
    const result = await dispatch(registry, 'browser.signin', { site }, context);
    expect(result).toMatchObject({ ok: true, data: { site, status: { state: 'signedOut', checkedAt: expect.any(String) } } });
    expect(s.pages[1]!.bringToFront).toHaveBeenCalledOnce();
    expect(s.newPage).not.toHaveBeenCalled();
    s.pages.forEach(p => expect(p.goto).not.toHaveBeenCalled());
    expect(s.pages[0]!.bringToFront).not.toHaveBeenCalled(); expect(s.pages[2]!.bringToFront).not.toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/private|43210|endpoint|https:/);
  }
});

it('11.6 owner TTY opens and retains the fixed sign-in entry in the resident profile when absent', async () => {
  for (const [site, entry] of [['canvas', 'https://canvas.lms.unimelb.edu.au/login/saml'], ['ed', 'https://edstem.org/au/login']] as const) {
    const s = setup(['https://canvas.lms.unimelb.edu.au/courses/1', 'https://edstem.org/au/courses/1', 'https://edstem.org.evil.invalid/au/login']);
    const registry = createRegistry({ browser: { signin: target => bringSignInToFront(target, s) } });
    const output: string[] = [];
    await parseProtocolCLI(['browser', 'signin', '--site', site], { registry, context: createFakeContext({ owner: true }), isTTY: true, stdout: line => output.push(line), stderr: () => {} });
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, data: { site, status: { state: 'signedOut' } } });
    expect(s.newPage).toHaveBeenCalledOnce();
    expect(s.pages[3]!.goto).toHaveBeenCalledWith(entry, { waitUntil: 'domcontentloaded', timeout: 10000 });
    expect(s.pages[3]!.bringToFront).toHaveBeenCalledOnce();
    s.pages.slice(0, 3).forEach(p => { expect(p.goto).not.toHaveBeenCalled(); expect(p.bringToFront).not.toHaveBeenCalled(); });
    expect(s.disconnect).toHaveBeenCalledOnce();
  }
});

it('11.6 reuses a Canvas sign-in tab redirected to the university Canvas SSO app', async () => {
  const s = setup([
    'https://sso.unimelb.edu.au/app/another_app/other/sso/saml',
    'https://sso.unimelb.edu.au.evil.invalid/app/universityofmelbourne_canvas_1/example/sso/saml',
    'https://sso.unimelb.edu.au/app/universityofmelbourne_canvas_1/example/sso/saml?SAMLRequest=private',
  ]);
  expect(await bringSignInToFront('canvas', s)).toMatchObject({ site: 'canvas', status: { state: 'signedOut' } });
  expect(s.newPage).not.toHaveBeenCalled();
  expect(s.pages[2]!.bringToFront).toHaveBeenCalledOnce();
  for (const p of s.pages) expect(p.goto).not.toHaveBeenCalled();
  for (const p of s.pages.slice(0, 2)) expect(p.bringToFront).not.toHaveBeenCalled();
});

it('11.6 coalesces concurrent same-site owner requests into one resident sign-in tab', async () => {
  const s = setup([]);
  const results = await Promise.all([bringSignInToFront('ed', s), bringSignInToFront('ed', s)]);
  expect(results).toEqual([expect.objectContaining({ site: 'ed' }), expect.objectContaining({ site: 'ed' })]);
  expect(s.newPage).toHaveBeenCalledOnce();
  expect(s.pages[0]!.bringToFront).toHaveBeenCalledOnce();
});
