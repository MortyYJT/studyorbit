import type { ReconcileScope } from '../sync/reconciliation.js';
import type { Module, Course, Assessment, SourceItem, Task, Change, Run } from '../domain/schemas.js';

/** Callers supply change content; the store owns sequence allocation. */
export type ChangeInput = Omit<Change, 'seq'>;

/** All supplied entities and changes are saved atomically. Omitted groups are unchanged. */
export interface SaveBatch {
  modules?: readonly Module[];
  courses?: readonly Course[];
  assessments?: readonly Assessment[];
  sourceItems?: readonly SourceItem[];
  tasks?: readonly Task[];
  changes?: readonly ChangeInput[];
  runs?: readonly Run[];
}

/** Saves upsert by id; absent loads return undefined. Changes are append-only. */
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
  recordRun(value: Run): void;
  loadRun(id: string): Run | undefined;
  recordChange(value: ChangeInput): Change;
  loadChange(seq: number): Change | undefined;
  saveBatch(batch: SaveBatch): Change[];
  /** Exclusive lower bound, returned in ascending sequence order. */
  listChangesSince(seq: number, limit?: number): Change[];
  reconcile(scopes: readonly ReconcileScope[], at: string): Change[];
  close(): void;
}
