export type ScoredField = 'kind' | 'nature' | 'parentId' | 'weight' | 'maxScore' | 'score' | 'due' | 'scoring' | 'status';
/** A validated course document (shared/course-data.ts); only `assessments` is read. */
export type DocumentLike = { assessments: Array<{ id: string; name: string; [key: string]: unknown }> };
export type Cell = { goldId: string; field: ScoredField; expected: unknown; actual: unknown };
export type DocumentScore = {
  correct: number; cells: number; fieldAccuracy: number | null; perField: Record<ScoredField, { correct: number; total: number }>;
  goldCount: number; predictedCount: number; matched: number; recall: number | null; precision: number | null;
  unmatchedGold: string[]; extraPredicted: string[]; mismatches: Cell[];
};
export type Consistency = {
  documentRuns: number; cells: number; agreeingCells: number; cellAgreement: number | null; identicalRuns: number; identicalToFirst: number | null;
};
export type Interception = { runs: number; repairTriggered: number; rejected: number; issues: Record<string, number> };
export type RunUsage = { input: number | null; output: number | null; [key: string]: unknown } | null;
export type EvalRun = { accepted: boolean; document: DocumentLike | null; attempts: Array<{ issues?: string[] }>; durationMs?: number; usage?: RunUsage };
export type CourseSummary = {
  runs: number; documentRuns: number; fieldAccuracy: number | null; perField: Record<ScoredField, number | null>;
  recall: number | null; precision: number | null; cellAgreement: number | null; identicalToFirst: number | null;
  interception: Interception; tokens: { input: number; output: number; runsWithUsage: number }; durationMs: { total: number; mean: number | null };
  counts: Record<string, unknown>; mismatches: Array<{ unmatchedGold: string[]; extraPredicted: string[]; mismatches: Cell[] }>;
};
export type OverallSummary = Omit<CourseSummary, 'counts' | 'mismatches'> & { courses: number };

export const SCORED_FIELDS: ScoredField[];
export const MISSING: '<missing>';
export function normaliseName(name: unknown): string;
export function normaliseIssue(message: string): string;
export function matchAssessments<G extends { id: string; name: string }, P extends { id: string; name: string }>(gold: G[], predicted: P[]): Array<{ gold: G; predicted: P | null }>;
export function scoreDocument(gold: DocumentLike, predicted: DocumentLike): DocumentScore;
export function normaliseDocument(document: DocumentLike): Array<Record<string, unknown>>;
export function consistency(gold: DocumentLike, documents: Array<DocumentLike | null>): Consistency;
export function interceptionCounts(runs: Array<Pick<EvalRun, 'accepted' | 'attempts'>>): Interception;
export function summariseCourse(gold: DocumentLike, runs: EvalRun[]): CourseSummary;
export function summariseOverall(summaries: CourseSummary[]): OverallSummary;
