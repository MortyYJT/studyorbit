import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';

export const EXTENSION_ORIGIN = 'chrome-extension://hjllbhkpkhffpbjkdpfigdnlaalopaij';
export interface ExtensionResponse { status: number; finalUrl: string; text: string }
export interface ExtensionReader { read(url: string): Promise<ExtensionResponse> }
const MAX_MESSAGE = 16 * 1024 * 1024;

/** Unmasked server frame; client frames are decoded and unmasked below. */
function frame(opcode: number, payload: Buffer): Buffer {
  const size = payload.length;
  const header = Buffer.alloc(size < 126 ? 2 : size <= 65535 ? 4 : 10);
  header[0] = 0x80 | opcode;
  header[1] = size < 126 ? size : size <= 65535 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(size, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(size), 2);
  return Buffer.concat([header, payload]);
}

/** One extension connection on the loopback interface; no reads until a sync asks for one. */
export class ExtensionBridge implements ExtensionReader {
  private readonly server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  private socket?: Duplex;
  private unavailable = false;
  private readonly pending = new Map<string, { resolve(value: ExtensionResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private readonly options: { port?: number; timeoutMs?: number } = {}) {
    this.server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      const key = req.headers['sec-websocket-key'];
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin !== EXTENSION_ORIGIN
        || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket'
        || !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade')
        || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string'
        || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy()); return;
      }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      // A new connection replaces a stale one (a worker that died without closing, for example after sleep).
      const stale = this.socket;
      if (stale) { this.disconnect(); stale.destroy(); }
      this.socket = socket;
      this.receive(socket, head);
    });
    // Keep listen failures (including an occupied port) local to this optional bridge.
    this.server.on('error', () => { this.unavailable = true; });
  }
  get port(): number {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : this.options.port ?? 47613;
  }
  async start(): Promise<boolean> {
    if (this.server.listening) return true;
    return new Promise(resolve => {
      const failed = () => { this.server.off('listening', ready); resolve(false); };
      const ready = () => { this.server.off('error', failed); this.unavailable = false; resolve(true); };
      this.server.once('error', failed); this.server.once('listening', ready);
      this.server.listen(this.options.port ?? 47613, '127.0.0.1');
    });
  }
  read(url: string): Promise<ExtensionResponse> {
    if (!this.socket) return Promise.reject(new Error(this.unavailable ? 'extension bridge unavailable' : 'extension disconnected'));
    const socket = this.socket; const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('extension timeout')); }, this.options.timeoutMs ?? 5_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(frame(1, Buffer.from(JSON.stringify({ id, type: 'read', url }))));
    });
  }
  async close(): Promise<void> {
    this.socket?.destroy();
    this.disconnect();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private disconnect(): void {
    this.socket = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('extension disconnected')); }
    this.pending.clear();
  }
  private message(payload: Buffer): void {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(value.id);
    if ('error' in value && typeof value.error === 'string') pending.reject(new Error(value.error));
    else if ('status' in value && Number.isInteger(value.status) && 'finalUrl' in value && typeof value.finalUrl === 'string'
      && 'text' in value && typeof value.text === 'string') {
      pending.resolve({ status: value.status as number, finalUrl: value.finalUrl, text: value.text });
    } else pending.reject(new Error('invalid extension response'));
  }
  private receive(socket: Duplex, head: Buffer): void {
    let buffer: Buffer = Buffer.alloc(0); let fragments: Buffer[] = []; let fragmentSize = 0; let fragmented = false;
    const fail = () => { this.disconnect(); socket.end(frame(8, Buffer.from([0x03, 0xea])), () => socket.destroy()); };
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (buffer.length >= 2) {
          const first = buffer[0]!; const second = buffer[1]!; const opcode = first & 15;
          const fin = (first & 0x80) !== 0;
          if ((first & 0x70) || !(second & 0x80) || ![0, 1, 8, 9, 10].includes(opcode)) { fail(); return; }
          let size = second & 127; let offset = 2;
          if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; if (size < 126) { fail(); return; } }
          else if (size === 127) {
            if (buffer.length < 10) return;
            const length = buffer.readBigUInt64BE(2);
            if (length < 65536n || length > BigInt(MAX_MESSAGE)) { fail(); return; }
            size = Number(length); offset = 10;
          }
          if (size > MAX_MESSAGE || (opcode >= 8 && (!fin || size > 125))) { fail(); return; }
          if (buffer.length < offset + 4 + size) return;
          const mask = buffer.subarray(offset, offset + 4); offset += 4;
          const payload = Buffer.from(buffer.subarray(offset, offset + size));
          buffer = buffer.subarray(offset + size);
          for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
          if (opcode === 8) { socket.end(frame(8, payload), () => socket.destroy()); this.disconnect(); return; }
          if (opcode === 9) { socket.write(frame(10, payload)); continue; }
          if (opcode === 10) continue;
          if ((opcode === 0 && !fragmented) || (opcode === 1 && fragmented)) { fail(); return; }
          fragments.push(payload); fragmentSize += size;
          if (fragmentSize > MAX_MESSAGE) { fail(); return; }
          fragmented = !fin;
          if (fin) { this.message(Buffer.concat(fragments)); fragments = []; fragmentSize = 0; }
        }
      } catch { fail(); }
    };
    socket.on('data', data);
    const disconnected = () => { if (this.socket === socket) this.disconnect(); socket.destroy(); };
    socket.on('error', disconnected); socket.on('end', disconnected); socket.on('close', disconnected);
    if (head.length) data(head);
  }
}
