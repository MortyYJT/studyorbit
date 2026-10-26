import type {
  AssessmentLink, Annotation, AnnotationVerdict, PlanningSettings,
  Estimate, StartTime, TimeLog, CourseAutonomy,
  Conversation, Message, PendingConfirmation, PracticeAttempt,
  SavedFile, SyncConflict
} from '../domain/schemas.js';
import type { Module, Course, Assessment, SourceItem, Task, Run } from '../domain/schemas.js';


/** All supplied entities are saved atomically. Omitted groups are unchanged. */
export interface SaveBatch {
  modules?: readonly Module[];
  courses?: readonly Course[];
  assessments?: readonly Assessment[];
  sourceItems?: readonly SourceItem[];
  tasks?: readonly Task[];
  runs?: readonly Run[];
  assessmentLinks?: readonly AssessmentLink[];
  annotations?: readonly Annotation[];
  annotationVerdicts?: readonly AnnotationVerdict[];
}

/** Saves upsert by id; absent loads return undefined. */
export interface Repository {
  saveModule(value: Module): void;
  loadModule(id: string): Module | undefined;
  saveCourse(value: Course): void;
  loadCourse(id: string): Course | undefined;
  saveAssessment(value: Assessment): void;
  loadAssessment(id: string): Assessment | undefined;
  saveSourceItem(value: SourceItem): void;
  loadSourceItem(id: string): SourceItem | undefined;
  saveTask(value: Task): void;
  loadTask(id: string): Task | undefined;
  deleteManualTask(id: string): void;
  recordRun(value: Run): void;
  loadRun(id: string): Run | undefined;
  saveSavedFile(value: SavedFile): void;
  loadSavedFile(id: string): SavedFile | undefined;
  listSavedFiles(courseId: string): SavedFile[];
  listSavedFilesForAssessment(assessmentId: string): SavedFile[];
  saveSyncConflict(value: SyncConflict): void;
  loadSyncConflict(id: string): SyncConflict | undefined;
  listSyncConflicts(courseId: string): SyncConflict[];
  listOpenSyncConflicts(courseId?: string): SyncConflict[];
  saveBatch(batch: SaveBatch): void;
  appendAssessmentLink(value: AssessmentLink): void;
  readAssessmentLinks(assessmentId: string): AssessmentLink[];
  listAssessmentLinks(): AssessmentLink[];
  appendAnnotation(value: Annotation): void;
  readAnnotations(entity: string, entityId: string): Annotation[];
  appendAnnotationVerdict(value: AnnotationVerdict): void;
  readAnnotationVerdicts(annotationId: string): AnnotationVerdict[];
  appendPlanningSettings(value: PlanningSettings): void;
  readPlanningSettings(): PlanningSettings[];
  appendEstimate(value: Estimate): void;
  readEstimates(workId: string): Estimate[];
  appendStartTime(value: StartTime): void;
  readStartTimes(workId: string): StartTime[];
  listStartTimes(): StartTime[];
  clearStartTime(workId: string, date: string): void;
  appendTimeLog(value: TimeLog): void;
  readTimeLogs(workId: string): TimeLog[];
  listTimeLogs(): TimeLog[];
  appendCourseAutonomy(value: CourseAutonomy): void;
  readCourseAutonomy(courseId: string): CourseAutonomy[];
  appendConversation(value: Conversation): void;
  readConversations(): Conversation[];
  appendMessage(value: Message): void;
  readMessages(conversationId: string): Message[];
  appendPendingConfirmation(value: PendingConfirmation): void;
  readPendingConfirmations(conversationId: string): PendingConfirmation[];
  appendPracticeAttempt(value: PracticeAttempt): void;
  readPracticeAttempts(questionId: string): PracticeAttempt[];
  close(): void;
}
