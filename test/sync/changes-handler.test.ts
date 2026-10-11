import { afterEach, expect, it } from 'vitest';
import { changesHandler } from '../../src/sync/changes-handler.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { synthetic } from '../fixtures/synthetic.js';
const stores: SqliteRepository[] = [];
function open() { const db = new SqliteRepository(':memory:'); stores.push(db); return db; }
afterEach(() => stores.splice(0).forEach(db => db.close()));
const { seq: _seq, ...event } = synthetic.change;
it('6.4 reads exclusive ascending pages and keeps empty cursors stable', async () => {
  const db = open(); for (let i = 0; i < 3; i++) db.recordChange(event);
  expect(await changesHandler(db, { since: 1, limit: 1 })).toMatchObject({ ok: true, data: { changes: [{ seq: 2 }], nextCursor: 2 } });
  expect(await changesHandler(db, { since: 2, limit: 1 })).toMatchObject({ ok: true, data: { changes: [{ seq: 3 }], nextCursor: 3 } });
  expect(await changesHandler(db, { since: 42 })).toMatchObject({ ok: true, data: { changes: [], nextCursor: 42 } });
  expect(db.listChangesSince(0, 2).map(e => e.seq)).toEqual([1, 2]);
});
it.each([-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null])('6.4 rejects invalid cursor %s', async since => {
  const db = open(); expect(await changesHandler(db, { since })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(() => db.listChangesSince(since as number)).toThrow();
});
it.each([0, -1, 1.5, 501, Infinity])('6.4 rejects invalid bound %s', async limit => {
  expect(await changesHandler(open(), { since: 0, limit })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
it('6.4 fits UTF-8 envelopes and resumes without skipping an oversized event', async () => {
  const db = open(); db.recordChange(event);
  db.recordChange({ ...event, after: { text: '文'.repeat(24000) } }); db.recordChange(event);
  const first = await changesHandler(db, { since: 0 });
  expect(first).toMatchObject({ ok: true, data: { changes: [{ seq: 1 }], nextCursor: 1 } });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(65536);
  const blocked = await changesHandler(db, { since: 1 });
  expect(blocked).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
  expect(blocked).not.toHaveProperty('data');
  expect(await changesHandler(db, { since: 1 })).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
  expect(db.listChangesSince(1).map(e => e.seq)).toEqual([2, 3]);
});
it('6.4 paginates multiple individually fitting events by serialized envelope size', async () => {
  const db = open(); for (let i = 0; i < 3; i++) db.recordChange({ ...event, after: { text: 'x'.repeat(30000) } });
  const page = await changesHandler(db, { since: 0 });
  expect(page).toMatchObject({ ok: true, data: { changes: [{ seq: 1 }, { seq: 2 }], nextCursor: 2 } });
  expect(await changesHandler(db, { since: 2 })).toMatchObject({ ok: true, data: { changes: [{ seq: 3 }], nextCursor: 3 } });
});
