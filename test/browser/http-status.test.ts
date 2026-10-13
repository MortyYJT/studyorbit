import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createRegistry } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';

// Run the actual HTTP routing callback with synthetic streams, never binding a socket.
const fake = vi.hoisted(() => ({ handle: undefined as ((req: IncomingMessage, res: ServerResponse) => void) | undefined }));
vi.mock('node:http', () => ({ createServer: (_options: unknown, handle: typeof fake.handle) => {
  fake.handle = handle;
  const server = new EventEmitter();
  return Object.assign(server, {
    setTimeout: () => {}, listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ address: '127.0.0.1', port: 43211 }), close: (done?: () => void) => done?.(),
  });
} }));
import { startHttpTransport } from '../../src/protocol/http.js';
it('3.3 browser.status routes through HTTP at L0 without a capability, one safe envelope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coursework-http-synthetic-'));
  const status = { canvas: { state: 'signedIn' as const, checkedAt: '2026-01-01T00:00:00.000Z' },
    ed: { state: 'unknown' as const, checkedAt: '2026-01-01T00:00:00.000Z' } };
  const read = vi.fn(async () => status);
  const transport = await startHttpTransport({ registry: createRegistry({ browser: { status: read } }),
    context: createFakeContext(), capabilityDirectory: root });
  try {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/browser.status',
      rawHeaders: ['Host', '127.0.0.1:43211', 'Content-Type', 'application/json'],
      socket: { setTimeout: vi.fn() }, resume: vi.fn() });
    const replies: string[] = []; let code = 0;
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
      writeHead: (value: number) => { code = value; }, destroy: vi.fn(),
      end: (text: string) => { replies.push(text); res.emit('finish'); } });
    const done = new Promise<void>(resolve => res.once('finish', resolve));
    fake.handle!(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit('data', Buffer.from('{}')); req.emit('end'); await done;
    expect(code).toBe(200); expect(replies).toHaveLength(1); expect(read).toHaveBeenCalledOnce();
    expect(JSON.parse(replies[0]!)).toMatchObject({ ok: true, command: 'browser.status', data: status });
    expect(replies[0]).not.toMatch(/endpoint|cookie|token|body/);
  } finally { await transport.close(); rmSync(root, { recursive: true, force: true }); }
});
