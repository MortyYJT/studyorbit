import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
function worker() {
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent: string[] = [];
    onopen?: () => void; onclose?: () => void; onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(readonly url: string) { sockets.push(this); }
    send(text: string) { this.sent.push(text); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  let alarm!: (value: { name: string }) => void;
  const fetch = vi.fn(async () => ({ status: 200, url: 'https://canvas.lms.unimelb.edu.au/api/v1/courses', text: async () => 'while(1);[]' }));
  const interval = vi.fn(); const clearInterval = vi.fn(); const create = vi.fn();
  runInNewContext(source, { WebSocket: Socket, fetch, AbortSignal, setInterval: interval, clearInterval,
    chrome: { runtime: { getManifest: () => ({ version: '1.0.0' }) }, alarms: { create, onAlarm: { addListener: (fn: typeof alarm) => { alarm = fn; } } } } });
  return { sockets, fetch, interval, clearInterval, create, alarm: (name = 'reconnect') => alarm({ name }) };
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
describe('Canvas extension worker', () => {
  it('ships a pinned MV3 manifest with only the approved permissions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['alarms']);
    expect(manifest.host_permissions).toEqual(['https://canvas.lms.unimelb.edu.au/*', 'http://127.0.0.1/*']);
    expect(manifest.content_scripts).toBeUndefined();
    const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
    expect([...hash].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('')).toBe('hjllbhkpkhffpbjkdpfigdnlaalopaij');
  });
  it('connects, sends hello/20s heartbeats, and reconnects only on the minute alarm', () => {
    const f = worker(); const ws = f.sockets[0]!;
    expect(ws.url).toBe('ws://127.0.0.1:47613');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledWith('reconnect', { periodInMinutes: 1 });
    ws.open(); expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'hello', version: '1.0.0' });
    expect(f.interval.mock.calls[0]![1]).toBe(20_000);
    f.interval.mock.calls[0]![0](); expect(JSON.parse(ws.sent[1]!)).toEqual({ type: 'ping' });
    f.alarm(); expect(f.sockets).toHaveLength(1);
    ws.close(); expect(f.clearInterval).toHaveBeenCalled();
    f.alarm('other'); expect(f.sockets).toHaveLength(1);
    f.alarm(); expect(f.sockets).toHaveLength(2);
  });
  it('rejects a disallowed URL without fetching', async () => {
    const f = worker(); const ws = f.sockets[0]!; ws.open();
    ws.message({ id: '1', type: 'read', url: 'https://canvas.lms.unimelb.edu.au/courses/1' }); await flush();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ id: '1', error: 'URL not allowed' });
  });
  it('performs one credentialed GET and returns the status, final URL and body', async () => {
    const f = worker(); const ws = f.sockets[0]!; ws.open();
    const url = 'https://canvas.lms.unimelb.edu.au/api/v1/courses';
    ws.message({ id: '1', type: 'read', url }); await flush();
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith(url, { method: 'GET', credentials: 'include', signal: expect.any(AbortSignal) });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ id: '1', status: 200, finalUrl: url, text: 'while(1);[]' });
  });
});
