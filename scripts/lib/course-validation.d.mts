import type { CourseDocument, CourseDocumentV2, CourseModelOutput } from '../../shared/course-data.ts';
import type { FrameworkComponent, FrameworkParsers } from './course-refs.mjs';
import type { FrameworkSource, Institution } from '../institutions/types.d.mts';

export type AnalysisCourse = { id: string; subjectCode: string; [key: string]: unknown };
export type AnalysisReport = { status: string; reason: string; document: unknown } | null;
export type Usage = { input: number | null; cached: number | null; output: number | null; reasoning: number | null };
export type ModelResult = { exitCode: number | null; lastMessage: string; usage: Usage | null; error?: string; threadId?: string | null; issues?: string[] };
export type Validation = { report: AnalysisReport; parsed: { success: boolean; data?: CourseModelOutput }; issues: string[]; valid: boolean; components: FrameworkComponent[] };
export type Attempt = { exitCode: number | null; raw: string; issues: string[]; usage: Usage | null };
/** Per-source collection flags by source id. */
export type CollectionFlags = Record<string, { failed?: boolean; partial?: boolean; unpaginated?: boolean }>;
export type CollectedData = { canvas?: unknown; ed?: unknown; handbook?: unknown };

export function validateAnalysis(raw: string, context: { course: AnalysisCourse; framework?: (FrameworkParsers & { label: string }) | null } & CollectedData): Validation;
export function repairPrompt(issues: string[], lastMessage: string): string;
export function combineUsage(attempts: Attempt[]): Usage | null;
export function analyseWithRepair(options: {
  instructions: string;
  run(prompt: string): Promise<ModelResult>;
  validate(raw: string): Validation;
  isCancelled(): boolean;
}): Promise<{ result: ModelResult; validation: Validation; attempts: Attempt[] }>;
export function settleCourse(options: { result: ModelResult; validation: Validation; collection: CollectionFlags; sources?: readonly { id: string; label: string }[]; data: CollectedData; previous?: CourseDocument | null; framework?: FrameworkSource | null }): {
  accepted: boolean; status: string; reason: string; document: CourseDocumentV2 | null; diagnostic: { raw: string; issues: string[] } | null;
};
