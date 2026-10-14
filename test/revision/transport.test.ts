import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import type { Page, Route } from 'playwright';
import { ResidentSourceTransport } from '../../src/revision/source-transport.js';
import { MAX_SOURCE_BYTES } from '../../src/revision/source-fetch.js';
const url = 'https://canvas.lms.unimelb.edu.au/courses/1/pages/exam';
function setup(response: Response, options: { ed?: boolean; token?: string } = {}) {
  const target = options.ed ? 'https://edstem.org/api/lessons/1' : url;
  const fetch = vi.fn(async () => response);
  let guard!: (route: Route) => Promise<void>;
  const removed: string[] = [];
  const page = {
    close: vi.fn(async () => {}), goto: vi.fn(async () => {}),
    route: vi.fn(async (_pattern: string, handler: typeof guard) => { guard = handler; }),
    evaluate: async (fn: (...args: never[]) => unknown, args: unknown) => runInNewContext(`(${fn.toString()})(args)`, {
      args, location: { origin: new URL(target).origin }, localStorage: { getItem: () => options.token },
      fetch, AbortSignal, Uint8Array, TextDecoder,
      DOMParser: class {
        parseFromString(text: string) {
          return { querySelector: () => null, querySelectorAll: (selector: string) => {
            removed.push(selector);
            if (selector.includes('data-author')) return [...text.matchAll(/<span class="author">(.*?)<\/span>/gs)].map(match => ({ textContent: match[1], remove: () => { text = text.replace(match[0], ''); } }));
            return [{ remove: () => { text = text.replace(/<script>.*?<\/script>|<div hidden>.*?<\/div>/gs, ''); } }];
          }, get body() { return { textContent: text.replace(/<[^>]*>/g, '') }; } };
        }
      },
    }),
  };
  const connection = { contexts: () => [{ newPage: async () => page as unknown as Page }], close: vi.fn(async () => {}) };
  const transport = new ResidentSourceTransport({ resident: { current: () => ({ endpoint: 'http://127.0.0.1:12345', pid: 1, browser: 'msedge', startedAt: '2026-01-01T00:00:00Z' }) }, connect: async () => connection });
  return { transport, target, fetch, page, connection, removed, guard: () => guard };
}
function response(body: string | Uint8Array, type: string, target = url) {
  const result = new Response(body as BodyInit, { headers: { 'content-type': type } });
  Object.defineProperty(result, 'url', { value: target }); return result;
}
it('fetches an inert HTML page with GET only, extracts visible text and closes owned tabs', async () => {
  const fixture = setup(response('<h1>Synthetic exam</h1><script>secret</script><div hidden>hidden answer</div>', 'text/html'));
  expect(await fixture.transport.read(url)).toMatchObject({ text: 'Synthetic exam' });
  expect(fixture.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET', redirect: 'manual', credentials: 'same-origin' }));
  expect(fixture.page.close).toHaveBeenCalledOnce(); expect(fixture.connection.close).toHaveBeenCalledOnce();
  const abort = vi.fn(async () => {}); const proceed = vi.fn(async () => {});
  for (const [target, method, navigation] of [['https://example.org/redirect', 'GET', false], [url, 'POST', false], [url, 'GET', true]] as const) {
    await fixture.guard()({ request: () => ({ url: () => target, method: () => method, isNavigationRequest: () => navigation }), abort, continue: proceed } as unknown as Route);
  }
  expect(abort).toHaveBeenCalledTimes(3); expect(proceed).not.toHaveBeenCalled();
});
it('refuses opaque redirects and cancels oversized streamed bodies without a content-length', async () => {
  const redirect = response('', 'text/plain'); Object.defineProperty(redirect, 'type', { value: 'opaqueredirect' });
  await expect(setup(redirect).transport.read(url)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', message: expect.stringContaining('Redirects') });
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_SOURCE_BYTES + 1)); }, cancel });
  const tooLarge = new Response(body); Object.defineProperty(tooLarge, 'url', { value: url });
  await expect(setup(tooLarge).transport.read(url)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(cancel).toHaveBeenCalledOnce();
});
it('keeps the Ed session token inside the browser and refuses missing authentication', async () => {
  const target = 'https://edstem.org/api/lessons/1';
  const fixture = setup(response('Synthetic', 'text/plain', target), { ed: true, token: 'synthetic-secret-token' });
  expect(await fixture.transport.read(target)).toMatchObject({ body: new Uint8Array(Buffer.from('Synthetic')) });
  expect(fixture.fetch).toHaveBeenCalledWith(target, expect.objectContaining({ headers: { 'x-token': 'synthetic-secret-token' } }));
  const signedOut = setup(response('Synthetic', 'text/plain', target), { ed: true });
  await expect(signedOut.transport.read(target)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  expect(signedOut.fetch).not.toHaveBeenCalled();
});
it('extracts HTML in Canvas JSON fields without exposing markup or hidden text', async () => {
  const fixture = setup(response(JSON.stringify({ title: 'Synthetic', body: '<p>Recursion.</p><script>hidden</script>' }), 'application/json'));
  expect(await fixture.transport.read(url)).toMatchObject({ text: 'Synthetic\nRecursion.' });
});

it('harvests author names before stripping DOM structure and keeps peer sections out of material text', async () => {
  const fixture = setup(response('<span class="author">Fictional Peer</span><p>Fictional Peer discussed recursion.</p>', 'text/html'));
  expect(await fixture.transport.read(url)).toMatchObject({ text: 'Fictional Peer discussed recursion.', privacyScope: { authors: [{ name: 'Fictional Peer' }] } });
});
