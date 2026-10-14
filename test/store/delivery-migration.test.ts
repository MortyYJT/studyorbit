import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';

it('adds delivery tables and columns in one migration without rewriting v2 rows or old L4 grants', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coursework-additive-'));
  const file = join(directory, 'db.sqlite');
  function inspect(mode: 'seed' | 'read') {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { up as initial } from './src/store/migrations/001-initial.ts';
      const db = new DatabaseSync(process.argv[1]);
      try {
        if (process.argv[2] === 'seed') {
          initial(db);
          db.exec('ALTER TABLE changes RENAME TO change_event; CREATE TABLE grants (id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version = 2');
          db.prepare('INSERT INTO change_event VALUES (?, ?, ?, ?, ?)').run(1, 'task', 'old-task', '2026-01-01T00:00:00Z', '{ "kind": "created", "opaque": "preserve spacing" }');
          db.prepare('INSERT INTO grants VALUES (?, ?)').run('old-grant', '{ "level": 4, "assessmentId": "old-assessment" }');
          db.prepare('INSERT INTO courses VALUES (?, ?, ?)').run('old-course', 'old-module', '{ "id": "old-course", "sourcesAbsent": true }');
        }
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
        const columns = Object.fromEntries(['courses', 'assessments', 'source_items', 'tasks', 'runs'].map(table => [table, db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name)]));
        process.stdout.write(JSON.stringify({ version: db.prepare('PRAGMA user_version').get().user_version, tables, columns,
          events: db.prepare('SELECT * FROM change_event').all(), grants: db.prepare('SELECT * FROM grants').all(), courses: db.prepare('SELECT id, moduleId, json FROM courses').all() }));
      } finally { db.close(); }
    `, file, mode], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  }
  try {
    const before = inspect('seed');
    new SqliteRepository(file).close();
    const after = inspect('read');
    expect(after.version).toBe(3);
    for (const name of ['assessment_links', 'annotations', 'annotation_verdicts', 'planning_settings', 'estimates', 'start_times', 'time_logs', 'course_autonomy', 'study_records', 'practice_attempts', 'conversations', 'messages', 'pending_confirmations']) expect(after.tables).toContain(name);
    for (const [table, columns] of Object.entries({ courses: ['sources'], assessments: ['origin', 'kind', 'weight'], source_items: ['facts', 'removed'], tasks: ['done', 'allDay'], runs: ['conversationId', 'turns'] })) expect(after.columns[table]).toEqual(expect.arrayContaining(columns));
    expect(after.events).toEqual(before.events);
    expect(after.grants).toEqual(before.grants);
    expect(after.courses).toEqual(before.courses);
    new SqliteRepository(file).close();
    expect(inspect('read')).toEqual(after);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
