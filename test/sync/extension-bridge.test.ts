import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionBridge, EXTENSION_ORIGIN } from '../../src/sync/extension-bridge.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function bridge(timeoutMs = 5_000) {
  const server = new ExtensionBridge({ port: 0, timeoutMs });
  cleanup.push(() => server.close());
  expect(await server.start()).toBe(true);
  return server;
}
async function connect(server: ExtensionBridge, origin = EXTENSION_ORIGIN) {
  // Node 24 accepts headers; the DOM-compatible global type omits this overload.
  const Client = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Client(`ws://127.0.0.1:${server.port}`, { headers: { Origin: origin } });
  cleanup.push(async () => { if (ws.readyState === WebSocket.OPEN) {
    const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve(), { once: true }));
    ws.close(); await closed;
  } });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
  });
  return ws;
}
const url = 'https://canvas.lms.unimelb.edu.au/api/v1/courses';
describe('extension bridge', () => {
  it('fails immediately without an extension', async () => {
    const server = new ExtensionBridge();
    const started = Date.now();
    await expect(server.read(url)).rejects.toThrow('disconnected');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  it('refuses the wrong origin; a new connection replaces a stale one', async () => {
    const server = await bridge();
    await expect(connect(server, 'http://example.com')).rejects.toThrow('upgrade refused');
    const stale = await connect(server);
    const closed = new Promise<void>(resolve => stale.addEventListener('close', () => resolve(), { once: true }));
    await connect(server);
    await closed;
  });
  it.each([20, 300, 70_000])('round trips text frames of %i bytes and ignores hello/heartbeat', async size => {
    const server = await bridge(); const ws = await connect(server);
    ws.send(JSON.stringify({ type: 'hello', version: '1.0.0' }));
    ws.send(JSON.stringify({ type: 'ping' }));
    const text = '课'.repeat(size);
    ws.addEventListener('message', event => {
      const request = JSON.parse(String(event.data));
      expect(request).toMatchObject({ type: 'read', url: url + '?q=' + 'x'.repeat(size) });
      ws.send(JSON.stringify({ id: request.id, status: 200, finalUrl: url, text }));
    });
    await expect(server.read(url + '?q=' + 'x'.repeat(size))).resolves.toEqual({ status: 200, finalUrl: url, text });
  });
  it('times out and propagates extension errors', async () => {
    const server = await bridge(30); const ws = await connect(server);
    await expect(server.read(url)).rejects.toThrow('timeout');
    ws.addEventListener('message', event => ws.send(JSON.stringify({ id: JSON.parse(String(event.data)).id, error: 'fetch failed' })));
    await expect(server.read(url)).rejects.toThrow('fetch failed');
  });
  it('rejects pending reads on disconnect', async () => {
    const server = await bridge(); const ws = await connect(server);
    const pending = expect(server.read(url)).rejects.toThrow('disconnected');
    ws.close(); await pending;
  });
  it('reports an occupied port as unavailable', async () => {
    const first = await bridge(); const second = new ExtensionBridge({ port: first.port });
    cleanup.push(() => second.close());
    expect(await second.start()).toBe(false);
    await expect(second.read(url)).rejects.toThrow('unavailable');
  });
});
