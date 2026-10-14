import { afterEach, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { SyncService } from '../../src/sync/service.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { clock, readers } from '../sync/delivery-fixture.js';
const stores: SqliteRepository[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
it('5.5 exposes owner-only sync.run and CLI coursework sync --course without agent authority', async () => {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const ports = readers(); const service = new SyncService({ store, clock: clock(), readers: async limiter => ({ canvas: { read: p => limiter.attempt(() => ports.canvas.read(p)) }, ed: { read: p => limiter.attempt(() => ports.ed.read(p)) } }) });
  const registry = createRegistry({ sync: service }); const context = createFakeContext({ owner: true });
  const rejected = await dispatch(registry, 'sync.run', {}, { ...context, owner: undefined });
  expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(ports.read).not.toHaveBeenCalled();
  const stdout = vi.fn();
  await parseProtocolCLI(['sync', '--course', 'ABCD10001', '--json'], { registry, context, isTTY: true, stdout, stderr: vi.fn() });
  const result = JSON.parse(stdout.mock.calls[0]![0]);
  expect(result).toMatchObject({ protocol: 'coursework.agent/v1', command: 'sync.run', ok: true, data: { providers: { canvas: { status: 'OK' }, ed: { status: 'OK' } } } });
  expect(stdout).toHaveBeenCalledTimes(1);
  const status = await dispatch(registry, 'sync.status', {}, context);
  expect(status).toMatchObject({ ok: true, data: { running: false, canvas: { lastSuccess: { id: result.data.run.id } } } });
});
it('5.5 production mounts the same injected service used by every transport', async () => {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const sync = { run: vi.fn(), status: vi.fn(() => ({ running: false, canvas: {}, ed: {} })) };
  const host = createProductionProtocol({ store, sync });
  expect(host.registry.get('sync.run')).toBeDefined();
  expect(await host.registry.get('sync.status')!.handler({}, host.context)).toEqual({ running: false, canvas: {}, ed: {} });
});
it('5.5 a large legal sync returns one bounded summary retaining provider outcomes and durable citations', async () => {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const ports = readers(); const original = ports.read.getMockImplementation()!;
  ports.read.mockImplementation(async p => {
    if (!p.includes('/assignment_groups?')) return original(p);
    const page = Number(p.split('page=').at(-1));
    return { kind: 'json', status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i, name: 'Synthetic group', group_weight: 1 })),
      ...(page < 4 ? { next: p.replace(/page=\d+$/, `page=${page + 1}`) } : {}) };
  });
  const service = new SyncService({ store, clock: clock(), readers: async limiter => ({ canvas: { read: p => limiter.attempt(() => ports.canvas.read(p)) }, ed: { read: p => limiter.attempt(() => ports.ed.read(p)) } }) });
  const result = await dispatch(createRegistry({ sync: service }), 'sync.run', {}, createFakeContext({ owner: true }));
  expect(result).toMatchObject({ ok: true, data: { providers: { canvas: { status: 'OK' }, ed: { status: 'OK' } }, details: { citations: 400 } } });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64 * 1024);
  expect(store.query('assessments', { limit: 500 }).items).toHaveLength(400);
  const assessment = store.query('assessments', { limit: 500 }).items[0]!;
  expect(store.readAssessmentLinks(assessment.id).some(l => store.loadSourceItem(l.sourceItemId)?.text.includes('citation:'))).toBe(true);
});
