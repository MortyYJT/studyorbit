import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import type { ChangeInput } from '../../src/store/repository.js';
import { synthetic } from '../fixtures/synthetic.js';

const stores: SqliteRepository[] = [];
const dirs: string[] = [];
function open(path = ':memory:') {
  const store = new SqliteRepository(path);
  stores.push(store);
  return store;
}
function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), 'coursework-changes-'));
  dirs.push(dir);
  return join(dir, 'db.sqlite');
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const { seq: _seq, ...input } = synthetic.change;

it('assigns increasing sequence numbers and lists exclusively since a seq in ascending order', () => {
  const store = open();
  const first = store.recordChange(input);
  const second = store.recordChange({ ...input, entityId: 'second' });
  expect(first.seq).toBe(1);
  expect(second.seq).toBe(2);
  expect(store.listChangesSince(first.seq)).toEqual([second]);
  expect(store.listChangesSince(0)).toEqual([first, second]);
  expect(store.listChangesSince(second.seq)).toEqual([]);
  expect(store.loadChange(second.seq)).toEqual(second);
  expect(store.loadChange(99)).toBeUndefined();
});

it('persists sequence allocation across reopening and independent connections', () => {
  const path = databasePath();
  const first = open(path);
  const second = open(path);
  expect(first.recordChange(input).seq).toBe(1);
  expect(second.recordChange(input).seq).toBe(2);
  first.close();
  const third = open(path);
  expect(third.recordChange(input).seq).toBe(3);
  expect(second.listChangesSince(0).map(change => change.seq)).toEqual([1, 2, 3]);
});

it('records changes in the same transaction as the entities that caused them', () => {
  const store = open();
  const changes = store.saveBatch({ tasks: [synthetic.task], changes: [input, input] });
  expect(changes.map(change => change.seq)).toEqual([1, 2]);
  expect(store.loadTask(synthetic.task.id)).toEqual(synthetic.task);
  expect(store.listChangesSince(0)).toEqual(changes);
});

it('rolls back entities and earlier changes when a later change is invalid without consuming seq', () => {
  const store = open();
  store.recordChange(input);
  const invalid: ChangeInput = { ...input, kind: 'updated', before: undefined };
  expect(() => store.saveBatch({ tasks: [synthetic.task], changes: [input, invalid] })).toThrow();
  expect(store.loadTask(synthetic.task.id)).toBeUndefined();
  expect(store.listChangesSince(0).map(change => change.seq)).toEqual([1]);
  expect(store.recordChange(input).seq).toBe(2);
});

it('ignores a caller-supplied seq and validates change payloads and run writes', () => {
  const store = open();
  const forged = { ...input, seq: 900 };
  expect(store.recordChange(forged).seq).toBe(1);
  expect(() => store.recordChange({ ...input, at: 'invalid' })).toThrow();
  expect(() => store.recordRun({ ...synthetic.run, outcome: 'bad' } as unknown as typeof synthetic.run)).toThrow();
  expect(store.loadRun(synthetic.run.id)).toBeUndefined();
  expect(store.listChangesSince(0)).toHaveLength(1);
});

it('rolls back a JSON serialization failure and rejects payloads lost during serialization', () => {
  const store = open();
  expect(() => store.saveBatch({ tasks: [synthetic.task], changes: [{ ...input, after: 1n }] })).toThrow();
  expect(store.loadTask(synthetic.task.id)).toBeUndefined();
  expect(() => store.recordChange({ ...input, after: () => 'lost' })).toThrow();
  expect(store.listChangesSince(0)).toEqual([]);
  expect(store.recordChange(input).seq).toBe(1);
});

it('validates changes when loading and listing persisted records', () => {
  const path = databasePath();
  const store = open(path);
  store.recordChange(input);
  store.close();
  const bytes = readFileSync(path);
  const offset = bytes.indexOf(Buffer.from('"kind":"created"'));
  expect(offset).toBeGreaterThan(-1);
  bytes.write('"kind":"invalid"', offset);
  writeFileSync(path, bytes);
  const reopened = open(path);
  expect(() => reopened.loadChange(1)).toThrow();
  expect(() => reopened.listChangesSince(0)).toThrow();
});
