import type { AnalysisCourse, Attempt, ModelResult } from './lib/course-validation.mjs';
import type { AnalysisConfig } from './lib/llm-config.mjs';
import type { CourseSummary, OverallSummary, RunUsage } from './lib/eval-score.mjs';
import type { CourseDocument } from '../shared/course-data.ts';

export type EvalOptions = {
  run?: string; courses: string; gold?: string; n: number; model?: string; provider?: string;
  fake?: string; fixture?: string; out?: string; live: boolean;
};
export type EvalCourse = { course: AnalysisCourse & { name?: string; term?: string | null }; canvas: unknown; ed: unknown; handbook: unknown; gold: CourseDocument };
export type EvalRunRecord = {
  index: number; accepted: boolean; status: string; reason: string; document: CourseDocument | null;
  attempts: Attempt[]; durationMs: number; usage: RunUsage;
};
export type CourseEvaluation = { id: string; code: string; runs: EvalRunRecord[]; summary: CourseSummary };
export type Skipped = { id: string; code?: string; reason: string };
export type EvalSummary = {
  startedAt: string; finishedAt: string; n: number; mode: 'fake' | 'model'; provider: string | null; model: string | null;
  courses: Array<{ id: string; code: string; summary: CourseSummary }>; overall: OverallSummary; skipped: Skipped[];
};
export type ModelRun = (prompt: string, context: { course: EvalCourse['course']; run: number }) => Promise<ModelResult>;

export function parseArgs(argv: string[]): EvalOptions;
export function loadFixture(dir: string): Promise<EvalCourse>;
export function loadRun(options: { runDir: string; coursesPath: string; goldDir: string }): Promise<{ courses: EvalCourse[]; skipped: Skipped[] }>;
export function createFakeRunner(dir: string): ModelRun;
export function evaluateCourses(options: { courses: EvalCourse[]; n: number; run: ModelRun; isCancelled?: () => boolean }): Promise<{ courses: CourseEvaluation[]; overall: OverallSummary }>;
export function resolveEvalConfig(projectDir: string, env: Record<string, string | undefined>, overrides?: { provider?: string; model?: string }): Promise<AnalysisConfig>;
export function formatSummary(summary: EvalSummary): string;
export function runEvaluation(options: EvalOptions, context: {
  projectDir: string; env?: Record<string, string | undefined>; log?: (line: string) => void; isCancelled?: () => boolean;
}): Promise<{ outDir: string; summary: EvalSummary; evaluation: { courses: CourseEvaluation[]; overall: OverallSummary } }>;
