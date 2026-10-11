import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ModuleSchema, CourseSchema, AssessmentSchema, SourceItemSchema, TaskSchema, ChangeSchema, RunSchema,
  type Module, type Course, type Assessment, type SourceItem, type Task, type Change, type Run,
} from '../domain/schemas.js';
import { migrate } from './migrations/index.js';
import type { ChangeInput, Repository, SaveBatch } from './repository.js';

interface EntitySchema<T> { parse(value: unknown): T }

export class SqliteRepository implements Repository {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private write<T extends { id: string }>(table: string, schema: EntitySchema<T>, input: T, columns: readonly (keyof T & string)[] = []): void {
    const value = schema.parse(input);
    const names = ['id', ...columns, 'json'];
    const params = [value.id, ...columns.map(column => value[column] ?? null), JSON.stringify(value)];
    this.db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${names.slice(1).map(name => `${name} = excluded.${name}`).join(', ')}`)
      .run(...params as (string | null)[]);
  }

  private load<T>(table: string, key: string, id: string | number, schema: EntitySchema<T>): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE ${key} = ?`).get(id);
    return row === undefined ? undefined : schema.parse(JSON.parse(row.json as string));
  }

  saveModule(value: Module): void { this.saveBatch({ modules: [value] }); }
  loadModule(id: string): Module | undefined { return this.load('modules', 'id', id, ModuleSchema); }
  saveCourse(value: Course): void { this.saveBatch({ courses: [value] }); }
  loadCourse(id: string): Course | undefined { return this.load('courses', 'id', id, CourseSchema); }
  saveAssessment(value: Assessment): void { this.saveBatch({ assessments: [value] }); }
  loadAssessment(id: string): Assessment | undefined { return this.load('assessments', 'id', id, AssessmentSchema); }
  saveSourceItem(value: SourceItem): void { this.saveBatch({ sourceItems: [value] }); }
  loadSourceItem(id: string): SourceItem | undefined { return this.load('source_items', 'id', id, SourceItemSchema); }
  saveTask(value: Task): void { this.saveBatch({ tasks: [value] }); }
  loadTask(id: string): Task | undefined { return this.load('tasks', 'id', id, TaskSchema); }
  recordRun(value: Run): void { this.saveBatch({ runs: [value] }); }
  loadRun(id: string): Run | undefined { return this.load('runs', 'id', id, RunSchema); }
  loadChange(seq: number): Change | undefined { return this.load('change_event', 'seq', seq, ChangeSchema); }

  recordChange(value: ChangeInput): Change {
    return this.saveBatch({ changes: [value] })[0];
  }

  private appendChange(input: ChangeInput): Change {
    const largest = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_event').get()!.seq as number;
    const change = ChangeSchema.parse({ ...input, seq: largest + 1 });
    const json = JSON.stringify(change);
    // Unknown before/after payloads must still satisfy the schema after JSON encoding.
    const persisted = ChangeSchema.parse(JSON.parse(json));
    this.db.prepare('INSERT INTO change_event (seq, entity, entityId, at, json) VALUES (?, ?, ?, ?, ?)')
      .run(persisted.seq, persisted.entity, persisted.entityId, persisted.at, json);
    return persisted;
  }

  listChangesSince(seq: number): Change[] {
    return this.db.prepare('SELECT json FROM change_event WHERE seq > ? ORDER BY seq ASC').all(seq)
      .map(row => ChangeSchema.parse(JSON.parse(row.json as string)));
  }

  saveBatch(batch: SaveBatch): Change[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of batch.modules ?? []) this.write('modules', ModuleSchema, value);
      for (const value of batch.courses ?? []) this.write('courses', CourseSchema, value, ['moduleId']);
      for (const value of batch.assessments ?? []) this.write('assessments', AssessmentSchema, value, ['courseId']);
      for (const value of batch.sourceItems ?? []) this.write('source_items', SourceItemSchema, value, ['platform', 'externalId', 'courseId']);
      for (const value of batch.tasks ?? []) this.write('tasks', TaskSchema, value, ['moduleId', 'courseId', 'assessmentId']);
      for (const value of batch.runs ?? []) this.write('runs', RunSchema, value, ['command', 'startedAt']);
      const changes = (batch.changes ?? []).map(value => this.appendChange(value));
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
