import type { Module, Course, Assessment, SourceItem, Task, Run } from '../domain/schemas.js';


/** All supplied entities are saved atomically. Omitted groups are unchanged. */
export interface SaveBatch {
  modules?: readonly Module[];
  courses?: readonly Course[];
  assessments?: readonly Assessment[];
  sourceItems?: readonly SourceItem[];
  tasks?: readonly Task[];
  runs?: readonly Run[];
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
  recordRun(value: Run): void;
  loadRun(id: string): Run | undefined;
  saveBatch(batch: SaveBatch): void;
  close(): void;
}
