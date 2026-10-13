import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withResidentBrowser } from '../../src/browser/attach.js';
import { Registry } from '../../src/protocol/registry.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { createFakeContext } from '../../src/protocol/fakes.js';

const state = { endpoint: 'http://127.0.0.1:43210', pid: 12345, browser: 'msedge' as const, startedAt: '2026-01-01T00:00:00.000Z' };
function setup() {
  const other = { close: vi.fn() }; const created: { close: ReturnType<typeof vi.fn> }[] = [];
  const context = { newPage: vi.fn(async () => { const page = { close: vi.fn(async () => {}) }; created.push(page); return page; }) };
  const connection = { contexts: () => [context], close: vi.fn(async () => {}) };
  const connect = vi.fn(async () => connection);
  return { other, created, context, connection, connect, resident: { current: () => state } };
}
it('3.2 attaches without launching, closes only created tabs and disconnects without closing the context', async () => {
  const s = setup();
  await withResidentBrowser(s, async session => { await session.newPage(); await session.newPage(); });
  expect(s.connect).toHaveBeenCalledExactlyOnceWith(state.endpoint);
  expect(s.created).toHaveLength(2); s.created.forEach(page => expect(page.close).toHaveBeenCalledOnce());
  expect(s.other.close).not.toHaveBeenCalled(); expect(s.connection.close).toHaveBeenCalledOnce();
});
it('3.2 cleans up owned tabs and sanitizes errors even on failure', async () => {
  const s = setup();
  await expect(withResidentBrowser(s, async session => {
    await session.newPage(); throw new Error(`Cookie=sentinel ${state.endpoint}`);
  })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', message: 'Resident browser operation unavailable.' });
  expect(s.created[0]!.close).toHaveBeenCalledOnce(); expect(s.connection.close).toHaveBeenCalledOnce();
});
it('3.2 missing browser returns exactly one AUTH_EXPIRED CLI envelope with the start hint, no connector or prompt', async () => {
  const s = setup(); const lines: string[] = []; const errors: string[] = [];
  const registry = new Registry();
  registry.register({ name: 'synthetic.read', level: 0, input: z.strictObject({}), output: z.null(),
    handler: () => withResidentBrowser({ ...s, resident: { current: () => undefined } }, async () => null) });
  const previous = process.exitCode;
  try { await parseProtocolCLI(['synthetic', 'read'], { registry, context: createFakeContext(), isTTY: false,
    stdout: line => lines.push(line), stderr: line => errors.push(line) }); }
  finally { process.exitCode = previous; }
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, error: { code: 'AUTH_EXPIRED', message: expect.stringContaining('coursework browser start') } });
  expect(s.connect).not.toHaveBeenCalled(); expect(s.context.newPage).not.toHaveBeenCalled();
  expect(JSON.stringify([lines, errors])).not.toMatch(/43210|Cookie|sentinel/);
});
