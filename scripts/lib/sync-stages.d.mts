import type { AnalysisConfig } from './llm-config.mjs';
import type { AnalysisResult } from './llm-providers.mjs';
import type { Limiter } from './rate-limit.mjs';
import type { StageName, StageRow, SyncStore } from './sync-store.mjs';
import type { Institution } from '../institutions/types.d.mts';
import type { CourseSource, SourceId } from '../sources/types.d.mts';

/** A source id (the checkpoint key and run-directory file name). */
export type Source = SourceId;
export type SourceEntry = { file: string; sha256: string; exitCode: number | null; reusedFrom?: string };
/** Checkpoint entries of the job's sources, by source id. */
export type Sources = Record<Source, SourceEntry>;
export type SyncCourse = { id: string; subjectCode: string; term?: unknown; name?: unknown; [key: string]: unknown };
export type CollectorRequest = {
  source: Source; script: string; args: string[]; env?: Record<string, string>; cwd: string; registerStop(stop: () => void): () => void; signal: AbortSignal;
};
export type CollectorRunner = (request: CollectorRequest) => Promise<{ code: number | null; error?: string }>;
export type ModelCaller = (config: AnalysisConfig, prompt: string, options: { schema: unknown; schemaPath: string; cwd: string; registerStop(stop: () => void): () => void; onPhase?(phase: string): void }) => Promise<AnalysisResult>;
export type SyncLimiters = { collect(key: string): Limiter; model(provider: string): Limiter };
export type MergePlan = { kind: 'complete' | 'conflict'; row: StageRow } | { kind: 'write'; path: string } | { kind: 'new' };

export const COLLECT_VERSION: number;
export const ANALYSE_VERSION: number;
export const VALIDATE_VERSION: number;
export const MERGE_VERSION: number;
export const STAGES: readonly StageName[];
export const REASONS: Readonly<Record<'collectUnexpected' | 'stageUnexpected' | 'modelFailed' | 'mergeTargetChanged' | 'courseRemoved', string>>;
export function canonicalJson(value: unknown): string;
export function sha256Hex(data: string | Uint8Array): string;
export function hashOf(value: unknown): string;
export function collectInputHash(input: { courseId: string; code: string; term: string; institution: string; canvasOrigin: string; edRegion: string; sources: readonly string[] }): string;
export function analyseInputHash(input: { prompt: string; config: Pick<AnalysisConfig, 'provider' | 'model' | 'baseUrl'> & Partial<AnalysisConfig> }): string;
export function validateInputHash(input: { analyseArtifact: string; sources: Sources; previous: string | null }): string;
export function mergeInputHash(input: { validateArtifact: string; courseDir: string }): string;
export function termLabel(term: unknown, institution?: Institution): string;
export function courseTerm(course: SyncCourse): string;
export function courseFolder(desktopDir: string, course: SyncCourse, institution?: Institution): string;
export function fileHash(path: string): Promise<string | null>;
export function captureEarlierDocument(store: SyncStore, desktopDir: string, course: SyncCourse, institution?: Institution): Promise<string | null>;
export function capturedDocument(store: SyncStore, hash: string | null): unknown;
export function verifySource(entry: unknown): Promise<boolean>;
export function reusableSources(store: SyncStore, jobId: string, courseId: string, inputHash: string, ids: readonly Source[]): Promise<Partial<Record<Source, { entry: SourceEntry; jobId: string }>>>;
export function reusableCheckpoint(store: SyncStore, jobId: string, courseId: string, stage: StageName, inputHash: string): { row: StageRow; artifact: any } | null;
export function readCollected(sources: Sources): Promise<Record<Source, any>>;
export type SourceFlags = { failed: boolean; partial: boolean; unpaginated: boolean };
export function sourceFlags(sources: Sources, data: Record<Source, any>): Record<Source, SourceFlags>;
export function planMerge(rows: StageRow[], inputHash: string): Promise<MergePlan>;
export function chooseCoursePath(courseDir: string, jobId: string): Promise<string>;
export function limiterKey(source: Pick<CourseSource, 'usesBrowser' | 'limiter'>): string;
export const spawnCollector: CollectorRunner;
export class StageError extends Error { code: string; reason: string; constructor(code: string, reason: string, extra?: Record<string, unknown>); }
export class StageFailure extends Error {
  stage: StageName; status: 'failed' | 'cancelled' | 'interrupted'; code: string; reason: string; usage: unknown; phases: Record<string, number>;
  constructor(input: { stage: StageName; status: 'failed' | 'cancelled' | 'interrupted'; code: string; reason: string; usage?: unknown; phases?: Record<string, number> });
}
export function collectStage(ctx: unknown, course: SyncCourse): Promise<{ sources: Sources; phases: Record<string, number>; reusedSources: Source[]; reused?: true }>;
export function analyseStage(ctx: unknown, course: SyncCourse, collected: { sources: Sources }): Promise<{ artifactHash: string; artifact: any; usage: unknown; durationMs: number; reused?: true }>;
export function validateStage(ctx: unknown, course: SyncCourse, collected: { sources: Sources }, analysed: { artifactHash: string; artifact: any }, previous: string | null): Promise<{ artifactHash: string; artifact: any; reused?: true }>;
export function mergeStage(ctx: unknown, course: SyncCourse, validated: { artifactHash: string; artifact: any }, previous: string | null): Promise<{ status: string; reason: string; file: string | null }>;
