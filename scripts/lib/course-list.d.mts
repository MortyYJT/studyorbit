export function parseCoursePage(text: string): unknown[];
export function normalizeCourses(items: unknown[]): Array<{ id: string; name: string; code: string | null; term: string | null; url: string }>;
export function subjectCode(code: unknown): string | null;
export function filterSubjects<T extends { code?: unknown }>(courses: T[]): Array<T & { subjectCode: string }>;
