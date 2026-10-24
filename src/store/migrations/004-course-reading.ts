import type { DatabaseSync } from 'node:sqlite';

/** Agent course reading: owner course selection and shared sync job state. Only adds tables (#107). */
export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE course_selection (key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
    CREATE TABLE sync_jobs (id TEXT PRIMARY KEY NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, json TEXT NOT NULL);
  `);
}
