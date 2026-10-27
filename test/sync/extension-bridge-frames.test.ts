import { Duplex } from 'node:stream';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise frame parsing without binding a port (also runs in the socket-restricted sandbox).
const servers = vi.hoisted(() => [] as Server[]);
vi.mock('node:http', async importOriginal => {
  const http = await importOriginal<typeof import('node:http')>();
  return { ...http, createServer: (...args: Parameters<typeof http.createServer>) => {
    const server = http.createServer(...args); servers.push(server); return server;
  } };
});
import { ExtensionBridge, EXTENSION_ORIGIN } from '../../src/sync/extension-bridge.js';
class Socket extends Duplex {
  readonly sent: Buffer[] = [];
  override _read() {}
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.sent.push(Buffer.from(chunk)); done(); }
}
function masked(opcode: number, payload: Buffer, fin = true): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = (fin ? 128 : 0) | opcode;
  header[1] = 128 | (header.length === 2 ? payload.length : header.length === 4 ? 126 : 127);
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([header, mask, Buffer.from(payload.map((value, i) => value ^ mask[i % 4]!))]);
}
function setup(head: Buffer = Buffer.alloc(0)) {
  const bridge = new ExtensionBridge(); const socket = new Socket();
  servers.at(-1)!.emit('upgrade', { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {
    origin: EXTENSION_ORIGIN, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  } }, socket, head);
  expect(socket.sent[0]!.toString()).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  return { bridge, socket };
}
const cleanup: ExtensionBridge[] = [];
afterEach(async () => { for (const bridge of cleanup.splice(0)) await bridge.close(); servers.length = 0; vi.useRealTimers(); });
function requestId(socket: Socket): string {
  const buffer = socket.sent.at(-1)!; const length = buffer[1]! & 127;
  return JSON.parse(buffer.subarray(length === 126 ? 4 : length === 127 ? 10 : 2).toString()).id;
}
describe('RFC 6455 bridge frames', () => {
  it.each([10, 300, 70_000])('decodes split masked frames with %i byte bodies', async size => {
    const { bridge, socket } = setup(masked(1, Buffer.from('{"type":"hello"}'))); cleanup.push(bridge);
    const pending = bridge.read('https://canvas.lms.unimelb.edu.au/api/v1/courses');
    const text = 'x'.repeat(size);
    const payload = masked(1, Buffer.from(JSON.stringify({ id: requestId(socket), status: 200, finalUrl: 'synthetic', text })));
    socket.emit('data', payload.subarray(0, 1)); socket.emit('data', payload.subarray(1, 7));
    socket.emit('data', payload.subarray(7, 10)); socket.emit('data', payload.subarray(10));
    await expect(pending).resolves.toEqual({ status: 200, finalUrl: 'synthetic', text });
  });
  it('reassembles fragmented text with ping/pong between fragments and echoes close', async () => {
    const { bridge, socket } = setup(); cleanup.push(bridge);
    const pending = bridge.read('synthetic');
    const reply = Buffer.from(JSON.stringify({ id: requestId(socket), status: 200, finalUrl: 'synthetic', text: '课程' }));
    const ping = Buffer.from('alive');
    socket.emit('data', Buffer.concat([masked(1, reply.subarray(0, reply.length - 4), false), masked(9, ping)]));
    expect(socket.sent.at(-1)).toEqual(Buffer.concat([Buffer.from([0x8a, ping.length]), ping]));
    socket.emit('data', masked(10, ping));
    socket.emit('data', masked(0, reply.subarray(reply.length - 4)));
    await expect(pending).resolves.toMatchObject({ text: '课程' });
    socket.emit('data', masked(8, Buffer.from([3, 232])));
    expect(socket.sent.at(-1)).toEqual(Buffer.from([0x88, 2, 3, 232]));
  });
  it('enforces the default five-second read deadline and ignores late answers', async () => {
    vi.useFakeTimers();
    const { bridge, socket } = setup(); cleanup.push(bridge);
    const pending = expect(bridge.read('synthetic')).rejects.toThrow('timeout');
    const id = requestId(socket);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await pending;
    socket.emit('data', masked(1, Buffer.from(JSON.stringify({ id, status: 200, finalUrl: 'synthetic', text: 'late' }))));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses a non-loopback peer before upgrading', () => {
    const bridge = new ExtensionBridge(); cleanup.push(bridge);
    for (const peer of [{ origin: EXTENSION_ORIGIN, address: '192.0.2.1' }]) {
      const socket = new Socket();
      servers.at(-1)!.emit('upgrade', { method: 'GET', socket: { remoteAddress: peer.address }, headers: { origin: peer.origin } }, socket, Buffer.alloc(0));
      expect(socket.sent[0]!.toString()).toContain('403 Forbidden');
    }
  });
  it.each([
    Buffer.from([0x81, 0]), // Unmasked client frame.
    masked(0, Buffer.from('orphan')), // Continuation without a text frame.
    masked(9, Buffer.alloc(126)), // Oversized control frame.
  ])('disconnects malformed frames and rejects pending reads', async invalid => {
    const { bridge, socket } = setup(); cleanup.push(bridge);
    const pending = expect(bridge.read('synthetic')).rejects.toThrow('disconnected');
    socket.emit('data', invalid); await pending;
  });
});
