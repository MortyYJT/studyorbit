import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { MemoryStore } from '../../web/src/memory.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { SqliteRepository } from '../../src/store/sqlite.js';

const stores: SqliteRepository[] = [];
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-memory-ui-')));
  vi.stubEnv('COURSEWORK_HOME', root); vi.stubEnv('HOME', root);
});
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('Edit and delete: new text, kind and live list use the owner session; add and deleted-source display survive refresh', async () => {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const host = createProductionProtocol({ store });
  const at = '2026-10-25T00:00:00.000Z';
  store.saveChat({ id: 'v-1', title: 'Synthetic source', adapter: 'synthetic', createdAt: at, updatedAt: at });
  store.saveMemory({ id: 'm1', kind: 'habit', text: 'Old text', origin: 'agent', conversationId: 'v-1', createdAt: at });
  store.saveMemory({ id: 'm2', kind: 'other', text: 'Delete me', origin: 'agent', conversationId: 'gone', createdAt: at });
  const owner = { assertOwner: vi.fn(async (_command: string) => {}) }; const secret = 'a'.repeat(64);
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ 'X-Coursework-Session': secret });
    const name = String(url).slice('/api/'.length);
    const result = await dispatch(host.registry, name, JSON.parse(String(init?.body)), { ...host.context, owner });
    return new Response(JSON.stringify(result));
  });
  const memory = new MemoryStore(createClient(secret, fetcher));
  await memory.load();
  expect(memory.getSnapshot().items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'm1', conversationId: 'v-1' }), expect.objectContaining({ id: 'm2', sourceDeleted: true })]));
  await memory.edit('m1', 'New text', 'weakness');
  expect(memory.getSnapshot().items?.find(item => item.id === 'm1')).toMatchObject({ text: 'New text', kind: 'weakness', conversationId: 'v-1', createdAt: at });
  await memory.remove('m2');
  expect(memory.getSnapshot().items?.map(item => item.id)).toEqual(['m1']);
  expect(store.loadMemory('m2')?.deletedAt).toBeTruthy();
  await memory.add({ text: 'Owner preference', kind: 'preference' });
  expect(memory.getSnapshot().items?.[0]).toMatchObject({ origin: 'owner', text: 'Owner preference' });
  expect(owner.assertOwner.mock.calls.map(call => call[0])).toEqual(['memory.edit', 'memory.delete', 'memory.add']);
});

it('requires owner authority for every memory write without issuing a request', async () => {
  const fetcher = vi.fn(); const memory = new MemoryStore(createClient(undefined, fetcher));
  expect(await memory.add({ kind: 'other', text: 'No session' })).toBe(false);
  expect(await memory.edit('m', 'No session', 'other')).toBe(false);
  expect(await memory.remove('m')).toBe(false);
  expect(memory.getSnapshot().error).toBe('OWNER_SESSION_EXPIRED'); expect(fetcher).not.toHaveBeenCalled();
});

it('paginates live memories newest first and retains visible rows after a failed edit', async () => {
  const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
  const row = (id: string) => ({ id, kind: 'other', origin: 'owner', text: id, createdAt: '2026-10-25T00:00:00.000Z' });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const command = String(url).slice('/api/'.length); const input = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, meta,
      ...(command === 'memory.list' ? { ok: true, data: input.cursor ? { items: [row('older')] } : { items: [row('newer')], nextCursor: 'next' } }
        : { ok: false, error: { code: 'INVALID_INPUT', message: 'Refused', retryable: false } }) }));
  });
  const memory = new MemoryStore(createClient('a'.repeat(64), fetcher));
  await memory.load(); await memory.load(true);
  expect(memory.getSnapshot().items?.map(item => item.id)).toEqual(['newer', 'older']);
  expect(await memory.edit('newer', 'Rejected', 'other')).toBe(false);
  expect(memory.getSnapshot().items?.[0].text).toBe('newer'); expect(memory.getSnapshot().error).toBe('INVALID_INPUT');
});
