import { assertStudyRecordReadable, recordSchemas, type StudyRecord } from '../protocol/study-writes.js';
import type { StudyCommand } from '../protocol/citations.js';
import { CourseworkError } from '../protocol/errors.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import { courseEvidenceSnapshot } from '../revision/source-fetch.js';
import {
  AssessmentLinkSchema, type AssessmentLink, AnnotationSchema, type Annotation,
  AnnotationVerdictSchema, type AnnotationVerdict, PlanningSettingsSchema, type PlanningSettings,
  EstimateSchema, type Estimate, StartTimeSchema, type StartTime,
  TimeLogSchema, type TimeLog, CourseAutonomySchema, type CourseAutonomy,
  ConversationSchema, type Conversation, MessageSchema, type Message,
  PendingConfirmationSchema, type PendingConfirmation, PracticeAttemptSchema, type PracticeAttempt
} from '../domain/schemas.js';
import { queryPlan, type Collection, type QueryInput, type QueryItem, type QueryPage, type CurrentStateReader } from './queries.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ModuleSchema, CourseSchema, AssessmentSchema, SourceItemSchema, TaskSchema, RunSchema,
  type Module, type Course, type Assessment, type SourceItem, type Task, type Run,
} from '../domain/schemas.js';
import { migrate } from './migrations/index.js';
import type { Repository, SaveBatch } from './repository.js';

interface EntitySchema<T> { parse(value: unknown): T }

export class SqliteRepository implements Repository, CurrentStateReader {
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

  loadStudyRecord(command: StudyCommand, id: string): StudyRecord | undefined {
    const row = this.db.prepare('SELECT json FROM study_records WHERE command = ? AND id = ?').get(command, id);
    return row ? recordSchemas[command].parse(JSON.parse(row.json as string)) : undefined;
  }
  listStudyRecords(command: StudyCommand): StudyRecord[] {
    return this.db.prepare('SELECT json FROM study_records WHERE command = ? ORDER BY id').all(command)
      .map(row => recordSchemas[command].parse(JSON.parse(row.json as string)));
  }
  publishStudyRecord(command: StudyCommand, id: string, expected: string | undefined, record: StudyRecord,
    evidence = new TrustedStoreEvidence(this)): void {
    const value = recordSchemas[command].parse(record);
    if (value.id !== id) throw new CourseworkError('INVALID_INPUT', 'Study identity mismatch.');
    assertStudyRecordReadable(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const courseId = 'courseId' in value ? value.courseId : value.task.courseId;
      if (!courseId || 'assessmentId' in value && this.loadAssessment(value.assessmentId)?.courseId !== courseId
        || courseEvidenceSnapshot(this, evidence, courseId).sourceRevision !== value.sourceRevision) {
        throw new CourseworkError('CONFLICT', 'Study sources changed; refresh before retrying.');
      }
      const result = expected === undefined
        ? this.db.prepare('INSERT INTO study_records (command, id, revision, json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .run(command, id, value.revision, JSON.stringify(value))
        : this.db.prepare('UPDATE study_records SET revision = ?, json = ? WHERE command = ? AND id = ? AND revision = ?')
          .run(value.revision, JSON.stringify(value), command, id, expected);
      if (result.changes !== 1) throw new CourseworkError('CONFLICT', 'Study revision changed; refresh before retrying.');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
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
    const params = [value.id, ...columns.map(column => {
      const field = value[column];
      return field === undefined ? null : typeof field === 'boolean' ? Number(field)
        : typeof field === 'object' ? JSON.stringify(field) : field;
    }), JSON.stringify(value)];
    this.db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${names.slice(1).map(name => `${name} = excluded.${name}`).join(', ')}`)
      .run(...params as (string | number | null)[]);
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

  /** Identifiers here are fixed by repository methods, never caller-supplied SQL. */
  private append<T>(table: string, schema: EntitySchema<T>, input: T, columns: readonly string[]): void {
    const value = schema.parse(input) as T & Record<string, unknown>;
    const names = [...columns.map(column => column === 'seq' ? 'messageSeq' : column), 'json'];
    this.db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...columns.map(column => value[column] ?? null) as (string | number | null)[], JSON.stringify(value));
  }

  private history<T>(table: string, schema: EntitySchema<T>, filters: Record<string, string>): T[] {
    const keys = Object.keys(filters);
    return this.db.prepare(`SELECT json FROM ${table}${keys.length ? ` WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}` : ''} ORDER BY seq`)
      .all(...Object.values(filters)).map(row => schema.parse(JSON.parse(row.json as string)));
  }

  appendAssessmentLink(value: AssessmentLink): void { this.append('assessment_links', AssessmentLinkSchema, value, ['assessmentId', 'sourceItemId']); }
  readAssessmentLinks(assessmentId: string): AssessmentLink[] { return this.history('assessment_links', AssessmentLinkSchema, { assessmentId }); }
  appendAnnotation(value: Annotation): void { this.append('annotations', AnnotationSchema, value, ['id', 'entity', 'entityId']); }
  readAnnotations(entity: string, entityId: string): Annotation[] { return this.history('annotations', AnnotationSchema, { entity, entityId }); }
  appendAnnotationVerdict(value: AnnotationVerdict): void { this.append('annotation_verdicts', AnnotationVerdictSchema, value, ['annotationId']); }
  readAnnotationVerdicts(annotationId: string): AnnotationVerdict[] { return this.history('annotation_verdicts', AnnotationVerdictSchema, { annotationId }); }
  appendPlanningSettings(value: PlanningSettings): void { this.append('planning_settings', PlanningSettingsSchema, value, []); }
  readPlanningSettings(): PlanningSettings[] { return this.history('planning_settings', PlanningSettingsSchema, {  }); }
  appendEstimate(value: Estimate): void { this.append('estimates', EstimateSchema, value, ['workId']); }
  readEstimates(workId: string): Estimate[] { return this.history('estimates', EstimateSchema, { workId }); }
  appendStartTime(value: StartTime): void { this.append('start_times', StartTimeSchema, value, ['workId', 'date']); }
  readStartTimes(workId: string): StartTime[] { return this.history('start_times', StartTimeSchema, { workId }); }
  appendTimeLog(value: TimeLog): void { this.append('time_logs', TimeLogSchema, value, ['workId']); }
  readTimeLogs(workId: string): TimeLog[] { return this.history('time_logs', TimeLogSchema, { workId }); }
  appendCourseAutonomy(value: CourseAutonomy): void { this.append('course_autonomy', CourseAutonomySchema, value, ['courseId']); }
  readCourseAutonomy(courseId: string): CourseAutonomy[] { return this.history('course_autonomy', CourseAutonomySchema, { courseId }); }
  appendConversation(value: Conversation): void { this.append('conversations', ConversationSchema, value, ['id', 'courseId', 'updatedAt']); }
  readConversations(): Conversation[] { return this.history('conversations', ConversationSchema, {  }); }
  appendMessage(value: Message): void { this.append('messages', MessageSchema, value, ['id', 'conversationId', 'seq']); }
  readMessages(conversationId: string): Message[] { return this.history('messages', MessageSchema, { conversationId }); }
  /** Chat journals live with their message JSON; no schema or historical rows are changed. */
  saveChat(conversation: Conversation, message?: Message, events?: readonly import('../agent/adapter.js').StoredEvent[], run?: Run): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.write('conversations', ConversationSchema, conversation, ['courseId', 'updatedAt']);
      if (message) {
        const value = MessageSchema.parse(message);
        this.db.prepare(`INSERT INTO messages (id, conversationId, messageSeq, json) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET json = excluded.json`)
          .run(value.id, value.conversationId, value.seq, JSON.stringify({ ...value, events: events ?? [] }));
      }
      if (run) this.write('runs', { parse: value => ({ ...RunSchema.parse(value),
        courseId: conversation.courseId, assessmentId: conversation.assessmentId }) }, run,
        ['command', 'startedAt', 'conversationId', 'turns']);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  readChatEvents(conversationId: string): import('../agent/adapter.js').StoredEvent[] {
    return this.db.prepare('SELECT json FROM messages WHERE conversationId = ? ORDER BY messageSeq').all(conversationId)
      .flatMap(row => (JSON.parse(row.json as string) as { events?: import('../agent/adapter.js').StoredEvent[] }).events ?? []);
  }
  /** Context is retained even after the owner deletes the conversation's prose. */
  readAgentRuns(): (Run & Pick<Conversation, 'courseId' | 'assessmentId'>)[] {
    return this.db.prepare("SELECT json FROM runs WHERE command = 'agent.reply' ORDER BY startedAt, id").all().map(row => {
      const raw = JSON.parse(row.json as string) as Record<string, unknown>;
      return { ...RunSchema.parse(raw),
        ...(typeof raw.courseId === 'string' ? { courseId: raw.courseId } : {}),
        ...(typeof raw.assessmentId === 'string' ? { assessmentId: raw.assessmentId } : {}) };
    });
  }
  deleteConversation(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['messages', 'pending_confirmations']) this.db.prepare(`DELETE FROM ${table} WHERE conversationId = ?`).run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      // Operational runs are retained for metrics; they never contain prompt or response prose.
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  appendPendingConfirmation(value: PendingConfirmation): void { this.append('pending_confirmations', PendingConfirmationSchema, value, ['id', 'conversationId', 'assessmentId']); }
  readPendingConfirmations(conversationId: string): PendingConfirmation[] { return this.history('pending_confirmations', PendingConfirmationSchema, { conversationId }); }
  appendPracticeAttempt(value: PracticeAttempt): void { this.append('practice_attempts', PracticeAttemptSchema, value, ['questionId', 'revision']); }
  readPracticeAttempts(questionId: string): PracticeAttempt[] { return this.history('practice_attempts', PracticeAttemptSchema, { questionId }); }

  query<K extends Collection>(collection: K, input: QueryInput<K>): QueryPage<QueryItem<K>> {
    const plan = queryPlan(collection, input);
    const values = this.db.prepare(plan.sql).all(...plan.params)
      .map(row => plan.schema.parse(JSON.parse(row.json as string))) as QueryItem<K>[];
    const items = values.slice(0, plan.limit);
    return { items, ...(values.length > plan.limit ? { nextCursor: plan.cursorFor(items.at(-1)!.id) } : {}) };
  }

  saveBatch(batch: SaveBatch): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const value of batch.modules ?? []) this.write('modules', ModuleSchema, value);
      for (const value of batch.courses ?? []) this.write('courses', CourseSchema, value, ['moduleId', 'sources']);
      for (const value of batch.assessments ?? []) this.write('assessments', AssessmentSchema, value, ['courseId', 'origin', 'kind', 'weight']);
      for (const value of batch.sourceItems ?? []) this.write('source_items', SourceItemSchema, value, ['platform', 'externalId', 'courseId', 'facts', 'removed']);
      for (const value of batch.tasks ?? []) this.write('tasks', TaskSchema, value, ['moduleId', 'courseId', 'assessmentId', 'done', 'allDay']);
      for (const value of batch.runs ?? []) this.write('runs', RunSchema, value, ['command', 'startedAt', 'conversationId', 'turns']);
      for (const value of batch.assessmentLinks ?? []) this.appendAssessmentLink(value);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
