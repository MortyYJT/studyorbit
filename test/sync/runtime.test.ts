import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { BrowserSession } from '../../src/browser/attach.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { productionSync, type SyncRuntimeOptions } from '../../src/sync/runtime.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { bodies, clock, json } from './delivery-fixture.js';
// Any accidental production profile attachment fails before accessing a profile or network.
vi.mock('../../src/browser/attach.js', () => ({ withResidentBrowser: async () => { throw new CourseworkError('AUTH_EXPIRED', 'Synthetic missing profile'); } }));
const stores: SqliteRepository[] = []; const homes: string[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); homes.splice(0).forEach(p => rmSync(p, { recursive: true })); });
function local() { const store = new SqliteRepository(':memory:'); stores.push(store); const home = mkdtempSync(join(tmpdir(), 'sync-synthetic-')); homes.push(home); return { store, home }; }
it('5.5 production lock covers independent hosts and releases after failed attachment', async () => {
  const { store, home } = local();
  let reject!: (e: Error) => void;
  const attach = vi.fn(async <T>(_op: (s: BrowserSession<Page>) => Promise<T>): Promise<T> => new Promise((_resolve, fail) => { reject = fail; }));
  const first = productionSync(store, { home, attach: attach as SyncRuntimeOptions['attach'], clock: clock() }); const second = productionSync(store, { home, attach: attach as SyncRuntimeOptions['attach'], clock: clock() });
  const pending = first.run({});
  expect(second.status().running).toBe(true);
  await expect(second.run({})).rejects.toMatchObject({ code: 'LOCKED' });
  expect(attach).toHaveBeenCalledTimes(1);
  reject(new CourseworkError('AUTH_EXPIRED', 'Synthetic expiry'));
  expect(await pending).toMatchObject({ providers: { canvas: { status: 'AUTH_EXPIRED' }, ed: { status: 'AUTH_EXPIRED' } } });
  expect(second.status().running).toBe(false);
});
it('5.4 production readers keep raw synthetic snapshots private and store only redacted text', async () => {
  const { store, home } = local(); let pages = 0;
  const input = bodies(); (input['/api/v1/courses/1/assignments?per_page=100&page=1'] as { description: string }[])[0]!.description = 'Synthetic Peer';
  const attach = async <T>(op: (s: BrowserSession<Page>) => Promise<T>) => op({ newPage: async () => {
    const origin = pages++ === 0 ? 'https://canvas.lms.unimelb.edu.au/' : 'https://edstem.org/au/';
    return { url: () => origin, close: async () => {}, evaluate: async <R>(script: string) => {
      const endpoint = Object.keys(input).find(p => script.includes(JSON.stringify(p)))!;
      return json(input[endpoint]) as R;
    } } as unknown as Page;
  } });
  const service = productionSync(store, { home, attach: attach as SyncRuntimeOptions['attach'], clock: clock() });
  expect((await service.run({})).run.requests).toBe(13);
  const directory = join(home, 'snapshots', 'canvas'); const files = readdirSync(directory);
  expect(files).toHaveLength(6); expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(files.every(p => (statSync(join(directory, p)).mode & 0o777) === 0o600)).toBe(true);
  expect(files.map(p => readFileSync(join(directory, p), 'utf8')).join('')).toContain('Synthetic Peer');
  expect(JSON.stringify(store.query('sourceItems', { limit: 100 }).items)).not.toContain('Synthetic Peer');
});
