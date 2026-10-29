import type { Institution } from '../institutions/types.d.mts';

export function parseCoursePage(text: string): unknown[];
export function normalizeCourses(items: unknown[], origin?: string): Array<{ id: string; name: string; code: string | null; term: string | null; url: string }>;
export function subjectCode(code: unknown, institution?: Institution): string | null;
export function filterSubjects<T extends { code?: unknown }>(courses: T[], institution?: Institution): Array<T & { subjectCode: string }>;
export function courseListOrigin(list: unknown): string;
