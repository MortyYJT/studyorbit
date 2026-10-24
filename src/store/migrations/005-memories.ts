import type { DatabaseSync } from 'node:sqlite';

/** Long-term memory (C-4): agent observations and owner memories. Only adds a table (#107). */
export function up(db: DatabaseSync): void {
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, courseId TEXT, json TEXT NOT NULL)');
}
