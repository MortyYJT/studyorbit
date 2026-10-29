export type GoldNumber = { value: number; tolerance?: number; source: { tool: string; args: Record<string, unknown>; path: string } };
export type Gold = {
  answer: string; numbers: GoldNumber[]; facts: string[][]; forbidden: string[]; refusal: boolean; expectTools: string[];
};
export type GradeCheck =
  | { check: 'call'; pass: false; found: string }
  | { check: 'number'; pass: boolean; expected: number; tolerance: number; found: number | null }
  | { check: 'fact'; pass: boolean; expected: string[]; found: string | null }
  | { check: 'forbidden'; pass: boolean; expected: string; found: string | null }
  | { check: 'refusal'; pass: boolean; found: string | null };
export type Grade = { pass: boolean; failedCall: boolean; checks: GradeCheck[] };
export const REFUSAL_MARKERS: readonly string[];
export const DEFAULT_TOLERANCE: number;
export function normalise(text: string): string;
export function extractNumbers(text: string): number[];
export function valueAt(value: unknown, path: string): unknown;
export function gradeAnswer(answer: { ok: boolean; text: string; stopped?: boolean; error?: string }, gold: Partial<Gold>): Grade;
