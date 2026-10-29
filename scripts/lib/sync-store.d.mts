import type { DatabaseSync } from 'node:sqlite';

export type JobStatus = 'running' | 'finished' | 'failed' | 'cancelled' | 'interrupted';
export type CourseStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type StageName = 'collect' | 'analyse' | 'validate' | 'merge';
export type StageStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type JobCourse = {
  courseId: string; position: number; previous: string | null; code: string | null; term: string | null;
  status: CourseStatus; phase: string | null; reason: string | null; file: string | null;
  stoppedStage: StageName | null; reused: boolean;
};
export type Job = {
  id: string; kind: 'course-sync'; status: JobStatus; provider: string | null; model: string | null;
  resumedFrom: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; error: string | null;
  courses: JobCourse[];
};
export type StageRow = {
  jobId: string; courseId: string; stage: StageName; inputHash: string; status: StageStatus;
  checkpoint: unknown; outputHash: string | null; reusedFrom: string | null; attempts: number; usage: unknown;
  startedAt: string | null; finishedAt: string | null; durationMs: number | null; errorCode: string | null; error: string | null;
};
export type Snapshot = {
  id: number; jobId: string; courseId: string; contentHash: string; version: number | null; document: string;
  status: string | null; reason: string | null; file: string | null; createdAt: string;
};

export type JobPatch = Partial<Pick<Job, 'status' | 'provider' | 'model' | 'startedAt' | 'finishedAt' | 'error'>>;
export type CoursePatch = Partial<Pick<JobCourse, 'previous' | 'code' | 'term' | 'status' | 'phase' | 'reason' | 'file' | 'stoppedStage' | 'reused'>>;
export type StagePatch = Partial<Omit<StageRow, 'jobId' | 'courseId' | 'stage'>>;
export type StageInput = { jobId: string; courseId: string; stage: StageName; inputHash: string } & StagePatch;

export type SyncStore = {
  readonly path: string;
  readonly version: number;
  transaction<T>(fn: () => T): T;
  createJob(input: {
    id: string; provider?: string | null; model?: string | null; resumedFrom?: string | null;
    courses: { courseId: string; code?: string | null; term?: string | null; previous?: string | null }[];
  }): Job;
  updateJob(id: string, patch: JobPatch): void;
  updateCourse(jobId: string, courseId: string, patch: CoursePatch): void;
  getJob(id: string): Job | null;
  newestJob(): Job | null;
  listJobs(limit?: number): Job[];
  childOf(jobId: string): Job | null;
  lineage(jobId: string): string[];
  putArtifact(content: string): string;
  getArtifact(hash: string): string | null;
  saveStage(row: StageInput): StageRow;
  updateStage(jobId: string, courseId: string, stage: StageName, patch: StagePatch): void;
  getStage(jobId: string, courseId: string, stage: StageName): StageRow | null;
  findCheckpoint(jobId: string, courseId: string, stage: StageName, inputHash: string): StageRow | null;
  lineageStages(jobId: string, courseId: string, stage: StageName): StageRow[];
  putSnapshot(input: { jobId: string; courseId: string; document: string; version?: number | null; status?: string | null; reason?: string | null; file?: string | null }): Snapshot;
  getSnapshot(jobId: string, courseId: string): Snapshot | null;
  markInterrupted(): { jobs: number; courses: number; stages: number };
  prune(options?: { keep?: number }): { jobs: number; artifacts: number };
  close(): void;
};

export type Migration = string | ((db: DatabaseSync) => void);
export type StoreUnavailableReason = 'NOT_A_DATABASE' | 'NEWER_VERSION' | 'MIGRATION_FAILED' | 'BACKUP_FAILED' | 'OPEN_FAILED';
export type OpenResult =
  | { ok: true; store: SyncStore }
  | { ok: false; error: 'SYNC_STORE_UNAVAILABLE'; reason: StoreUnavailableReason; message: string };

export const STORE_FILE: string;
export const MIGRATIONS: readonly Migration[];
export const RETENTION_LINEAGES: number;
export const LINEAGE_ANCESTORS: number;
export function sha256(text: string): string;
export function storePath(projectDir: string): string;
export function openSyncStore(options: { projectDir: string; clock?: () => number; migrations?: readonly Migration[] }): Promise<OpenResult>;
