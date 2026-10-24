import { z } from 'zod';
import { VerifiedCitationSchema } from '../protocol/contracts.js';
import { CitationSchema } from '../domain/schemas.js';
import { assertStudyRecordReadable, recordSchemas, type StudyRecord } from '../protocol/study-writes.js';
import type { StudyCommand } from '../protocol/citations.js';
import { CourseworkError } from '../protocol/errors.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import { courseEvidenceSnapshot } from '../revision/sources.js';
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
  ModuleSchema, CourseSchema, AssessmentSchema, SourceItemSchema, TaskSchema, RunSchema, CourseSelectionSchema, SyncJobSchema,
  type Module, type Course, type Assessment, type SourceItem, type Task, type Run, type CourseSelection, type SyncJob,
} from '../domain/schemas.js';
import { migrate } from './migrations/index.js';
import type { Repository, SaveBatch } from './repository.js';

// Retain verified offsets and source hashes without changing the domain schema or migration.
const storedAnnotationSchema = AnnotationSchema.safeExtend({ citations: z.array(z.union([VerifiedCitationSchema, CitationSchema])) });

interface EntitySchema<T> { parse(value: unknown): T }

export class SqliteRepository implements Repository, CurrentStateReader {
  private readonly db: DatabaseSync;
  private closed = false;
  private inTransaction = false;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    // The `coursework mcp` process writes agent results while the starting process reads; wait briefly for locks.
    this.db = new DatabaseSync(path, { timeout: 5000 });
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
  deleteManualTask(id: string): void { this.db.prepare("DELETE FROM tasks WHERE id = ? AND json_extract(json, '$.source') = 'manual'").run(id); }
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
  listAssessmentLinks(): AssessmentLink[] { return this.history('assessment_links', AssessmentLinkSchema, {}); }
  appendAnnotation(value: Annotation): void { this.append('annotations', storedAnnotationSchema, value, ['id', 'entity', 'entityId']); }
  readAnnotations(entity: string, entityId: string): Annotation[] { return this.history('annotations', storedAnnotationSchema, { entity, entityId }); }
  appendAnnotationVerdict(value: AnnotationVerdict): void { this.append('annotation_verdicts', AnnotationVerdictSchema, value, ['annotationId']); }
  readAnnotationVerdicts(annotationId: string): AnnotationVerdict[] { return this.history('annotation_verdicts', AnnotationVerdictSchema, { annotationId }); }
  appendPlanningSettings(value: PlanningSettings): void { this.append('planning_settings', PlanningSettingsSchema, value, []); }
  readPlanningSettings(): PlanningSettings[] { return this.history('planning_settings', PlanningSettingsSchema, {  }); }
  appendEstimate(value: Estimate): void { this.append('estimates', EstimateSchema, value, ['workId']); }
  readEstimates(workId: string): Estimate[] { return this.history('estimates', EstimateSchema, { workId }); }
  appendStartTime(value: StartTime): void { this.append('start_times', StartTimeSchema, value, ['workId', 'date']); }
  readStartTimes(workId: string): StartTime[] { return this.history('start_times', StartTimeSchema, { workId }); }
  listStartTimes(): StartTime[] { return this.history('start_times', StartTimeSchema, {}); }
  clearStartTime(workId: string, date: string): void { this.db.prepare('DELETE FROM start_times WHERE workId = ? AND date = ?').run(workId, date); }
  appendTimeLog(value: TimeLog): void { this.append('time_logs', TimeLogSchema, value, ['workId']); }
  readTimeLogs(workId: string): TimeLog[] { return this.history('time_logs', TimeLogSchema, { workId }); }
  listTimeLogs(): TimeLog[] { return this.history('time_logs', TimeLogSchema, {}); }
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
  /** Durable browser confirmations share Issue A's table and never reconstruct actions. */
  listPendingConfirmations(): PendingConfirmation[] {
    return this.history('pending_confirmations', PendingConfirmationSchema, {});
  }
  savePendingConfirmation(input: PendingConfirmation): void {
    const row = PendingConfirmationSchema.parse(input);
    this.db.prepare(`INSERT INTO pending_confirmations (id, conversationId, assessmentId, json) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(row.id, row.conversationId, row.assessmentId, JSON.stringify(row));
  }
  transitionPendingConfirmation(id: string, state: 'confirmed' | 'cancelled' | 'expired'): PendingConfirmation | undefined {
    const row = this.db.prepare(`UPDATE pending_confirmations
      SET json = json_set(json, '$.state', ?, '$.decidedAt', ?)
      WHERE id = ? AND json_extract(json, '$.state') = 'pending' RETURNING json`)
      .get(state, new Date().toISOString(), id);
    return row ? PendingConfirmationSchema.parse(JSON.parse(row.json as string)) : undefined;
  }
  appendPracticeAttempt(value: PracticeAttempt): void { this.append('practice_attempts', PracticeAttemptSchema, value, ['questionId', 'revision']); }
  readPracticeAttempts(questionId: string): PracticeAttempt[] { return this.history('practice_attempts', PracticeAttemptSchema, { questionId }); }

  query<K extends Collection>(collection: K, input: QueryInput<K>): QueryPage<QueryItem<K>> {
    const plan = queryPlan(collection, input);
    const values = this.db.prepare(plan.sql).all(...plan.params)
      .map(row => plan.schema.parse(JSON.parse(row.json as string))) as QueryItem<K>[];
    const items = values.slice(0, plan.limit);
    return { items, ...(values.length > plan.limit ? { nextCursor: plan.cursorFor(items.at(-1)!.id) } : {}) };
  }

  /** Filter by the same append-order precedence used by annotation reads, before pagination. */
  queryEffectiveAssessments(input: QueryInput<'assessments'>, resolveKind?: (id: string) => string | null): QueryPage<QueryItem<'assessments'>> {
    const plan = queryPlan('assessments', input);
    const latest = `(SELECT a.json FROM annotations a WHERE a.entity = 'assessment' AND a.entityId = assessments.id
      AND json_extract(a.json, '$.field') = 'kind'
      ORDER BY CASE json_extract(a.json, '$.origin') WHEN 'owner' THEN 0 ELSE 1 END, a.seq DESC LIMIT 1)`;
    // A recorded null explicitly clears classification instead of falling through to the platform kind.
    if (resolveKind) this.db.function('effective_assessment_kind', id => resolveKind(String(id)));
    const kind = resolveKind ? 'effective_assessment_kind(assessments.id)' : `(CASE WHEN ${latest} IS NOT NULL THEN json_extract(${latest}, '$.value') ELSE json_extract(assessments.json, '$.kind') END)`;
    const rows = this.db.prepare(plan.sql.replace("json_extract(json, '$.kind')", kind)).all(...plan.params);
    const values = rows.map(row => AssessmentSchema.parse(JSON.parse(row.json as string)));
    const items = values.slice(0, plan.limit);
    return { items, ...(values.length > plan.limit ? { nextCursor: plan.cursorFor(items.at(-1)!.id) } : {}) };
  }

  /** Newest append wins globally per platform item; prior assignments remain in history. */
  currentAssessmentLinks(assessmentId: string): AssessmentLink[] {
    const rows = this.db.prepare('SELECT json FROM assessment_links WHERE seq IN (SELECT MAX(seq) FROM assessment_links GROUP BY sourceItemId) AND assessmentId = ? ORDER BY seq').all(assessmentId);
    return rows.map(row => AssessmentLinkSchema.parse(JSON.parse(row.json as string)));
  }

  private savepoints = 0;
  /**
   * One write transaction; a nested call runs in a savepoint of the outer one, so a caller can combine its own rows with
   * saveBatch and a failing inner step is undone without losing the outer rows.
   */
  transaction<T>(operation: () => T): T {
    if (this.inTransaction) {
      const name = `nested_${++this.savepoints}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = operation();
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`);
        throw error;
      } finally { this.savepoints--; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.inTransaction = false; }
  }
  listCourseSelections(): CourseSelection[] {
    return this.db.prepare('SELECT json FROM course_selection ORDER BY key').all().map(row => CourseSelectionSchema.parse(JSON.parse(row.json as string)));
  }
  saveCourseSelections(rows: readonly CourseSelection[]): void {
    this.transaction(() => {
      for (const row of rows) {
        const value = CourseSelectionSchema.parse(row);
        this.db.prepare('INSERT INTO course_selection (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(value.key, JSON.stringify(value));
      }
    });
  }
  loadSyncJob(id: string): SyncJob | undefined { return this.load('sync_jobs', 'id', id, SyncJobSchema); }
  /** Newest first. */
  listSyncJobs(): SyncJob[] {
    return this.db.prepare('SELECT json FROM sync_jobs ORDER BY startedAt DESC, id DESC').all().map(row => SyncJobSchema.parse(JSON.parse(row.json as string)));
  }
  saveSyncJob(job: SyncJob): void {
    const value = SyncJobSchema.parse(job);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO sync_jobs (id, startedAt, endedAt, json) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET endedAt = excluded.endedAt, json = excluded.json`).run(value.id, value.startedAt, value.endedAt ?? null, JSON.stringify(value));
    });
  }

  saveBatch(batch: SaveBatch, validate?: () => void): void {
    this.transaction(() => {
      validate?.();
      for (const value of batch.modules ?? []) this.write('modules', ModuleSchema, value);
      for (const value of batch.courses ?? []) this.write('courses', CourseSchema, value, ['moduleId', 'sources']);
      for (const value of batch.assessments ?? []) this.write('assessments', AssessmentSchema, value, ['courseId', 'origin', 'kind', 'weight']);
      for (const value of batch.sourceItems ?? []) this.write('source_items', SourceItemSchema, value, ['platform', 'externalId', 'courseId', 'facts', 'removed']);
      for (const value of batch.tasks ?? []) this.write('tasks', TaskSchema, value, ['moduleId', 'courseId', 'assessmentId', 'done', 'allDay']);
      for (const value of batch.runs ?? []) this.write('runs', RunSchema, value, ['command', 'startedAt', 'conversationId', 'turns']);
      for (const value of batch.assessmentLinks ?? []) this.appendAssessmentLink(value);
      for (const value of batch.annotations ?? []) this.appendAnnotation(value);
      for (const value of batch.annotationVerdicts ?? []) this.appendAnnotationVerdict(value);
    });
  }
}
