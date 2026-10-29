// The institution plugin interface (openspec change generic-adapters, design §4, decisions #441, #448).
import type { HandbookComponent, HandbookRow } from '../lib/course-refs.mjs';
import type { CourseSource } from '../sources/types.d.mts';

export type TermKey = { year: string | null; session: string | null };

/** The institution's official assessment framework (UniMelb: the Handbook). The contract value stays `handbook`. */
export interface FrameworkSource extends CourseSource {
  platform: 'handbook';
  /** Origins its bridge may open. */
  origins: readonly string[];
  parseRows(text: unknown): HandbookRow[];
  parseComponents(text: unknown): HandbookComponent[];
  /** The framework clauses of the analysis prompt's rules 3 and 6 (wired into the prompt in PR 3). */
  promptRules: { refs: string; quote: string };
}

export interface Institution {
  id: 'unimelb';
  label: { zh: string; en: string };
  defaults: { canvasOrigin: string | null; timeZone: string | null };
  /** The course filter: the subject code of a Canvas `course_code`, or null. */
  subjectCode(courseCode: unknown): string | null;
  isSubjectCode(code: unknown): boolean;
  termKey(term: string | null | undefined): TermKey;
  /** '2026 S2' for UniMelb. */
  termLabel(term: unknown): string;
  /** Path segments under the Desktop. */
  courseFolder(course: { term?: unknown; subjectCode: string }): string[];
  edSessionMatches(session: unknown, key: TermKey): boolean;
  /** Today's wording; wired into the prompts in PR 3. */
  wording: {
    assistantIntro: { zh: string; en: string };
    timeLabel: { zh: string; en: string };
    sourcesRule: string;
  };
  framework: FrameworkSource | null;
}
