import type { CourseDocument } from '../shared/course-data.js';
import type { ToolContext } from '../shared/course-tools.js';
import type { SentPlanning } from '../shared/planning-snapshot.js';
import type { Gold, Grade } from './lib/qa-grade.mjs';
import type { ChatStep } from './lib/chat-store.mjs';
import type { TokenCounts } from './lib/llm-providers.mjs';

export const PROJECT_DIR: string;
export type QaMode = 'context' | 'tools';
export type QaOptions = {
  mode: 'both' | QaMode; n: number; concurrency: number; only?: string[];
  provider?: string; model?: string; fake?: string; out?: string; fixtures?: string; rescore?: string;
};
export type QaQuestion = { id: string; category: string; language: 'zh' | 'en'; scope: string[]; question: string; gold: Gold };
export type QaFixtures = {
  today: string; courses: { id: string; code?: string; name?: string }[]; scope: string[];
  documents: CourseDocument[]; planning: SentPlanning | null; questions: QaQuestion[];
};
export type QaRecord = {
  id: string; mode: QaMode; run: number; category?: string; language?: string; question?: string;
  ok: boolean; text: string; stopped?: boolean; error?: string;
  steps: Partial<ChatStep>[]; usage: TokenCounts | null; model?: string | null; fallback: boolean; durationMs: number; grade: Grade;
};
export type QaModeSummary = {
  answers: number; passed: number; accuracy: number | null; failedCalls: number; fallbacks: number;
  byCategory: Record<string, { answers: number; passed: number; accuracy: number | null }>;
  perQuestion: Record<string, { answers: number; passed: number; rate: number | null }>;
  toolUse: { answersWithStep: number; toolCalls: number; calculationAnswers: number; calculationAnswersWithTool: number; byTool: Record<string, number> };
  tokens: { input: number; cached: number; output: number; reasoning: number; answersWithUsage: number };
  durationMs: { total: number; mean: number; max: number };
};
export type QaSummary = {
  startedAt: string; finishedAt?: string; provider: string | null; model: string | null; n: number; mode?: string;
  source?: string; originalStartedAt?: string | null;
  questions: number; only?: string[] | null; cancelled?: boolean; modes: Partial<Record<QaMode, QaModeSummary>>;
};
export function parseArgs(argv: string[]): QaOptions;
export function loadQaFixtures(dir: string): Promise<QaFixtures>;
export function toolContextFor(fixtures: QaFixtures, question: QaQuestion): ToolContext;
export function summariseQa(records: QaRecord[], questions: Pick<QaQuestion, 'id' | 'category'>[]): Partial<Record<QaMode, QaModeSummary>>;
export function formatQaSummary(summary: Pick<QaSummary, 'startedAt' | 'provider' | 'model' | 'n' | 'questions' | 'modes'> & { mode?: string }): string;
export function runQaEvaluation(
  options: QaOptions,
  context?: { projectDir?: string; env?: Record<string, string | undefined>; log?: (line: string) => void; isCancelled?: () => boolean },
): Promise<{ outDir: string; summary: QaSummary; records: QaRecord[] }>;
