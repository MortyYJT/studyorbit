// The institution plugin interface (openspec change generic-adapters, design §4, decisions #441, #448).
import type { FrameworkComponent, FrameworkRow } from '../lib/course-refs.mjs';
import type { CourseSource } from '../sources/types.d.mts';

/** Plugin ids of the registry. */
export type InstitutionId = 'unimelb' | 'generic';

export type TermKey = { year: string | null; session: string | null };

/** The institution's official assessment framework (for example a handbook). The contract value stays `handbook`. */
export interface FrameworkSource extends CourseSource {
  platform: 'handbook';
  /** Origins its bridge may open. */
  origins: readonly string[];
  parseRows(text: unknown): FrameworkRow[];
  parseComponents(text: unknown): FrameworkComponent[];
  /**
   * The framework clauses of the analysis prompt: rule 3 (`refs`), and rule 6 (`quote`: the quotable units, `quoteRow`:
   * how to copy a table row, `percent`: the cited component's percentage as weight evidence).
   */
  promptRules: { refs: string; quote: string; quoteRow: string; percent: string };
}

export interface Institution {
  id: InstitutionId;
  label: { zh: string; en: string };
  /** The institution's Canvas origin and time zone; null when the owner's settings provide them. */
  defaults: { canvasOrigin: string | null; timeZone: string | null };
  /** The course filter: the subject code of a Canvas `course_code`, or null. */
  subjectCode(courseCode: unknown): string | null;
  isSubjectCode(code: unknown): boolean;
  termKey(term: string | null | undefined): TermKey;
  termLabel(term: unknown): string;
  /** Path segments under the Desktop. */
  courseFolder(course: { term?: unknown; subjectCode: string }): string[];
  edSessionMatches(session: unknown, key: TermKey): boolean;
  wording: {
    /** The first line of both chat system prompts. */
    assistantIntro: { zh: string; en: string };
    /** The time zone's name in prompts (zh) and chat tool descriptions (en). */
    timeLabel: { zh: string; en: string };
    /** Rule 1 of the analysis prompt. */
    sourcesRule: string;
  };
  framework: FrameworkSource | null;
}
