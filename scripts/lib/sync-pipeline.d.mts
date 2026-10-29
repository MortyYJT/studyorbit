import type { AnalysisConfig } from './llm-config.mjs';
import type { TokenCounts } from './llm-providers.mjs';
import type { Clock } from './rate-limit.mjs';
import type { CollectorRunner, ModelCaller, Source, SyncLimiters } from './sync-stages.mjs';
import type { CourseStatus, JobStatus, StageName, SyncStore } from './sync-store.mjs';

export type CourseSyncRow = {
  id: string; code: string; status: CourseStatus; reason: string; phase?: string; file?: string; stage: StageName | null; reused: boolean;
};
export type CourseSyncState = {
  running: boolean; courses: CourseSyncRow[]; error: string | null; jobId: string | null; resumedFrom?: string | null; resumable: boolean;
};
export type SyncJobSummary = {
  id: string; status: JobStatus; createdAt: string; finishedAt: string | null; resumedFrom: string | null; resumable: boolean;
  courses: { id: string; code: string; status: CourseStatus }[];
};
export type PipelineHooks = {
  beforeStage?(stage: StageName, courseId: string): void | Promise<void>;
  afterCheckpoint?(stage: StageName, courseId: string): void | Promise<void>;
  afterMergeWrite?(courseId: string): void | Promise<void>;
};
export type PipelineDeps = {
  store: SyncStore; projectDir: string; desktopDir: string; env?: Record<string, string | undefined>;
  runCollector?: CollectorRunner; callModel?: ModelCaller; resolveModel?: () => Promise<AnalysisConfig>;
  childUsage?: (threadId: string | null | undefined, start: Date) => Promise<TokenCounts | null>;
  clock?: Clock; random?: () => number; limiters?: SyncLimiters; hooks?: PipelineHooks; newId?: () => string;
};
export type SyncPipeline = {
  start(ids: string[]): Promise<CourseSyncState>;
  resume(jobId: string): Promise<CourseSyncState>;
  cancel(): CourseSyncState;
  shutdown(): Promise<void>;
  status(): CourseSyncState;
  jobs(): SyncJobSummary[];
  running(): boolean;
  idle(): Promise<void>;
};
export const RESUME_WINDOW_MS: number;
export const MODEL_CONCURRENCY: number;
export const COLLECTOR_INTERVAL_MS: number;
export class SimulatedCrash extends Error {}
export function createSyncLimiters(options?: { clock?: Clock; random?: () => number }): SyncLimiters & { collect(source: Source): ReturnType<SyncLimiters['collect']> };
export function codexChildUsage(parentId: string | null | undefined, start: Date): Promise<TokenCounts | null>;
export function createSyncPipeline(deps: PipelineDeps): SyncPipeline;
