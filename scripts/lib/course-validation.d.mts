import type { CourseDocumentV1 } from '../../shared/course-data.ts';

export type AnalysisCourse = { id: string; subjectCode: string; [key: string]: unknown };
export type AnalysisReport = { status: string; reason: string; document: unknown } | null;
export type Usage = { input: number | null; cached: number | null; output: number | null; reasoning: number | null };
export type ModelResult = { exitCode: number | null; lastMessage: string; usage: Usage | null; error?: string; threadId?: string | null; issues?: string[] };
export type Validation = { report: AnalysisReport; parsed: { success: boolean; data?: CourseDocumentV1 }; issues: string[]; valid: boolean };
export type Attempt = { exitCode: number | null; raw: string; issues: string[]; usage: Usage | null };
export type CollectionFlags = { canvasFailed?: boolean; canvasUnpaginated?: boolean; edFailed?: boolean; edPartial?: boolean; handbookFailed?: boolean };

export function validateAnalysis(raw: string, context: { course: AnalysisCourse; canvas: unknown; ed: unknown }): Validation;
export function repairPrompt(issues: string[], lastMessage: string): string;
export function combineUsage(attempts: Attempt[]): Usage | null;
export function analyseWithRepair(options: {
  instructions: string;
  run(prompt: string): Promise<ModelResult>;
  validate(raw: string): Validation;
  isCancelled(): boolean;
}): Promise<{ result: ModelResult; validation: Validation; attempts: Attempt[] }>;
export function settleCourse(options: { result: ModelResult; validation: Validation; collection: CollectionFlags }): {
  accepted: boolean; status: string; reason: string; document: CourseDocumentV1 | null; diagnostic: { raw: string; issues: string[] } | null;
};
