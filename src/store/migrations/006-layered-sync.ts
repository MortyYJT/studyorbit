import type { DatabaseSync } from 'node:sqlite';

/**
 * Layered sync (C-5): saved course files and Canvas/skeleton conflicts. Only adds tables and indexes (#107); the new
 * assessment, run and sync-job fields live in their existing JSON columns.
 */
export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE saved_files (
      id TEXT PRIMARY KEY NOT NULL,
      courseId TEXT NOT NULL,
      assessmentId TEXT,
      savedAt TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX saved_files_course ON saved_files (courseId);
    CREATE INDEX saved_files_assessment ON saved_files (assessmentId);
    CREATE TABLE sync_conflicts (
      id TEXT PRIMARY KEY NOT NULL,
      courseId TEXT NOT NULL,
      field TEXT NOT NULL,
      state TEXT NOT NULL,
      checkedAt TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX sync_conflicts_course ON sync_conflicts (courseId);
    CREATE INDEX sync_conflicts_open ON sync_conflicts (courseId, state);
  `);
}
