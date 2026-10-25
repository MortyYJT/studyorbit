import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { synthetic } from '../fixtures/synthetic.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coursework-sync-upgrade-'));
  directories.push(directory);
  return join(directory, 'db.sqlite');
}
// Isolated Node process creates/inspects wholly synthetic historical databases.
// Production SQL stays in src/store; fixtures do not expose a repository SQL API.
function fixture(file: string, statements: { sql: string; params?: (string | number)[] }[] = [], query = 'PRAGMA user_version') {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const [file, statements, query] = JSON.parse(process.argv[1]);
    const db = new DatabaseSync(file);
    try {
      for (const statement of statements) db.prepare(statement.sql).run(...(statement.params ?? []));
      process.stdout.write(JSON.stringify(db.prepare(query).all()));
    } finally { db.close(); }
  `, JSON.stringify([file, statements, query])], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}
function legacy(file: string, events = true) {
  const definitions = [
    'modules (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL)',
    'courses (id TEXT PRIMARY KEY NOT NULL, moduleId TEXT NOT NULL, json TEXT NOT NULL)',
    'assessments (id TEXT PRIMARY KEY NOT NULL, courseId TEXT NOT NULL, json TEXT NOT NULL)',
    'source_items (id TEXT PRIMARY KEY NOT NULL, platform TEXT NOT NULL, externalId TEXT NOT NULL, courseId TEXT, json TEXT NOT NULL)',
    'tasks (id TEXT PRIMARY KEY NOT NULL, moduleId TEXT NOT NULL, courseId TEXT, assessmentId TEXT, json TEXT NOT NULL)',
    'runs (id TEXT PRIMARY KEY NOT NULL, command TEXT NOT NULL, startedAt TEXT NOT NULL, json TEXT NOT NULL)',
    'changes (seq INTEGER PRIMARY KEY, entity TEXT NOT NULL, entityId TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL)',
  ];
  const statements: { sql: string; params?: (string | number)[] }[] = definitions.map(definition => ({ sql: `CREATE TABLE ${definition}` }));
  for (const [table, value, fields] of [
    ['modules', synthetic.module, []], ['courses', synthetic.course, ['moduleId']],
    ['assessments', synthetic.assessments[0], ['courseId']],
    ['source_items', synthetic.sourceItem, ['platform', 'externalId', 'courseId']],
    ['tasks', synthetic.task, ['moduleId', 'courseId', 'assessmentId']],
    ['runs', synthetic.run, ['command', 'startedAt']],
  ] as const) {
    const data = value as unknown as Record<string, string>;
    statements.push({ sql: `INSERT INTO ${table} (id, ${fields.length ? fields.join(', ') + ', ' : ''}json) VALUES (${['id', ...fields, 'json'].map(() => '?').join(', ')})`,
      params: [data.id, ...fields.map(field => data[field]), JSON.stringify(value)] });
  }
  if (events) {
    const kinds = ['item.added', 'content.changed', 'deadline.changed', 'grade.changed', 'item.removed'];
    kinds.forEach((kind, index) => {
      const event = { seq: index + 8, kind, entity: 'task', entityId: synthetic.task.id,
        ...(kind !== 'item.added' ? { before: synthetic.task } : {}),
        ...(kind !== 'item.removed' ? { after: synthetic.task } : {}), at: synthetic.run.startedAt };
      statements.push({ sql: 'INSERT INTO changes VALUES (?, ?, ?, ?, ?)',
        params: [event.seq, event.entity, event.entityId, event.at, JSON.stringify(event)] });
    });
  }
  statements.push({ sql: 'PRAGMA user_version = 1' });
  fixture(file, statements);
}
function tables(file: string) { return fixture(file, [], "SELECT name, type FROM sqlite_master WHERE name IN ('changes', 'change_event') ORDER BY name"); }

it('upgrades every historical operation and preserves entities, runs and historical snapshots (2.2/2.4)', () => {
  const file = path(); legacy(file);
  const oldEvents = fixture(file, [], 'SELECT json FROM changes ORDER BY seq').map((row: { json: string }) => JSON.parse(row.json));
  const store = new SqliteRepository(file);
  try {
    expect(store.loadModule(synthetic.module.id)).toEqual(synthetic.module);
    expect(store.loadCourse(synthetic.course.id)).toEqual(synthetic.course);
    expect(store.loadAssessment(synthetic.assessments[0].id)).toEqual(synthetic.assessments[0]);
    expect(store.loadSourceItem(synthetic.sourceItem.id)).toEqual(synthetic.sourceItem);
    expect(store.loadTask(synthetic.task.id)).toEqual(synthetic.task);
    expect(store.loadRun(synthetic.run.id)).toEqual(synthetic.run);
    const kinds = ['created', 'updated', 'updated', 'updated', 'deleted'];
    expect(fixture(file, [], 'SELECT json FROM change_event ORDER BY seq').map((row: { json: string }) => JSON.parse(row.json))).toEqual(oldEvents.map((event: object, index: number) => ({ ...event, kind: kinds[index] })));
  } finally { store.close(); }
  expect(fixture(file)).toEqual([{ user_version: 5 }]);
  expect(tables(file)).toEqual([{ name: 'change_event', type: 'table' }]);
  const bytes = readFileSync(file);
  const reopened = new SqliteRepository(file); reopened.close();
  expect(readFileSync(file)).toEqual(bytes);
});

it.each(['column', 'json', 'both'])('stops for legacy iCal in %s before writes with safe owner guidance (2.4)', location => {
  const file = path(); legacy(file);
  const source = { ...synthetic.sourceItem, platform: location === 'column' ? 'manual' : 'ical', title: 'private-title-sentinel' };
  fixture(file, [{ sql: 'UPDATE source_items SET platform = ?, json = ?', params: [location === 'json' ? 'manual' : 'ical', JSON.stringify(source)] }]);
  const bytes = readFileSync(file);
  expect(() => new SqliteRepository(file)).toThrow(/iCal.*owner.*retention.*removal/i);
  try { new SqliteRepository(file); } catch (error) { expect(String(error)).not.toContain('private-title-sentinel'); }
  expect(readFileSync(file)).toEqual(bytes);
  expect(tables(file)).toEqual([{ name: 'changes', type: 'table' }]);
  expect(fixture(file)).toEqual([{ user_version: 1 }]);
});

it.each(['bad-kind', 'bad-snapshot', 'mismatched-seq', 'table-conflict'])('rolls back %s after preserving the original database (2.4)', failure => {
  const file = path(); legacy(file);
  const broken = { entity: 'task', entityId: synthetic.task.id, at: synthetic.run.startedAt, seq: failure === 'mismatched-seq' ? 900 : 12, kind: failure === 'bad-kind' ? 'private-token-sentinel' : 'item.removed',
    before: failure === 'bad-snapshot' ? undefined : synthetic.task, after: undefined };
  fixture(file, [failure === 'table-conflict'
    ? { sql: 'CREATE TABLE change_event (seq INTEGER PRIMARY KEY)' }
    : { sql: 'UPDATE changes SET json = ? WHERE seq = 12', params: [JSON.stringify(broken)] }]);
  const bytes = readFileSync(file);
  expect(() => new SqliteRepository(file)).toThrow();
  try { new SqliteRepository(file); } catch (error) { expect(String(error)).not.toContain('private-token-sentinel'); }
  expect(readFileSync(file)).toEqual(bytes);
  expect(fixture(file)).toEqual([{ user_version: 1 }]);
});

it('migrates an empty historical event table without adding events (2.4)', () => {
  const file = path(); legacy(file, false);
  const store = new SqliteRepository(file);
  try {
    store.saveTask(synthetic.task);
    expect(fixture(file, [], 'SELECT * FROM change_event')).toEqual([]);
  } finally { store.close(); }
});
