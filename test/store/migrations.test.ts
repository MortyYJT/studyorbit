import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { synthetic } from '../fixtures/synthetic.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'coursework-migration-'));
  dirs.push(dir);
  return join(dir, 'db.sqlite');
}
// PRAGMA user_version is a big-endian 32-bit integer at SQLite header offset 60.
function version(file: string) { return readFileSync(file).readUInt32BE(60); }
function setVersion(file: string, value: number) {
  const bytes = readFileSync(file);
  bytes.writeUInt32BE(value, 60);
  writeFileSync(file, bytes);
}

it('creates a fresh database with every migration applied and its version recorded', () => {
  const file = path();
  const store = new SqliteRepository(file);
  try {
    store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course],
      assessments: synthetic.assessments, sourceItems: [synthetic.sourceItem],
      tasks: [synthetic.task], runs: [synthetic.run] });
  } finally { store.close(); }
  expect(version(file)).toBe(6);
});

it('does not reapply migrations or modify an up-to-date database', () => {
  const file = path();
  const first = new SqliteRepository(file);
  first.saveModule(synthetic.module);
  first.close();
  const before = readFileSync(file);
  const second = new SqliteRepository(file);
  expect(second.loadModule(synthetic.module.id)).toEqual(synthetic.module);
  second.close();
  expect(readFileSync(file)).toEqual(before);
});

it('refuses a newer database naming both versions and leaves the file unchanged', () => {
  const file = path();
  const first = new SqliteRepository(file);
  first.saveTask(synthetic.task);
  first.close();
  setVersion(file, 7);
  const before = readFileSync(file);
  expect(() => new SqliteRepository(file)).toThrow(/version 7.*version 6/);
  expect(readFileSync(file)).toEqual(before);
});

it('rolls back a failing migration without changing its recorded version or data', () => {
  const file = path();
  const first = new SqliteRepository(file);
  first.saveTask(synthetic.task);
  first.close();
  // Simulate an inconsistent pre-versioned database: initial tables already exist.
  setVersion(file, 0);
  const before = readFileSync(file);
  expect(() => new SqliteRepository(file)).toThrow();
  expect(version(file)).toBe(0);
  expect(readFileSync(file)).toEqual(before);
});
