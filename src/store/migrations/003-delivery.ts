import type { DatabaseSync } from 'node:sqlite';

/** Add delivery storage without touching historical JSON, events or grants. */
export function up(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE courses ADD COLUMN sources TEXT;
    ALTER TABLE assessments ADD COLUMN origin TEXT;
    ALTER TABLE assessments ADD COLUMN kind TEXT;
    ALTER TABLE assessments ADD COLUMN weight REAL;
    ALTER TABLE source_items ADD COLUMN facts TEXT;
    ALTER TABLE source_items ADD COLUMN removed INTEGER;
    ALTER TABLE tasks ADD COLUMN done INTEGER;
    ALTER TABLE tasks ADD COLUMN allDay INTEGER;
    ALTER TABLE runs ADD COLUMN conversationId TEXT;
    ALTER TABLE runs ADD COLUMN turns INTEGER;
    CREATE TABLE assessment_links (seq INTEGER PRIMARY KEY, assessmentId TEXT NOT NULL, sourceItemId TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE annotations (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, entity TEXT NOT NULL, entityId TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE annotation_verdicts (seq INTEGER PRIMARY KEY, annotationId TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE planning_settings (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE estimates (seq INTEGER PRIMARY KEY, workId TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE start_times (seq INTEGER PRIMARY KEY, workId TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE time_logs (seq INTEGER PRIMARY KEY, workId TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE course_autonomy (seq INTEGER PRIMARY KEY, courseId TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE study_records (command TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (command, id));
    CREATE TABLE practice_attempts (seq INTEGER PRIMARY KEY, questionId TEXT NOT NULL, revision TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE conversations (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, courseId TEXT, updatedAt TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, conversationId TEXT NOT NULL, messageSeq INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE (conversationId, messageSeq));
    CREATE TABLE pending_confirmations (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, conversationId TEXT NOT NULL, assessmentId TEXT NOT NULL, json TEXT NOT NULL);
  `);
}
