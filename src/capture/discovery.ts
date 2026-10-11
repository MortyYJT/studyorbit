import { CourseworkError } from '../protocol/errors.js';
export const CANVAS_ORIGIN = 'https://canvas.lms.unimelb.edu.au';
export const ED_ORIGIN = 'https://edstem.org';
export type CourseSource = 'canvas' | 'ed';
export interface CourseTerm { label: string; year?: number; session?: string }
export interface SelectedCourse { source: CourseSource; origin: string; id: string; term: CourseTerm }
export interface CourseChoice extends SelectedCourse { name: string; code?: string }
export type DiscoveryResult = { source: CourseSource; status: 'available'; courses: CourseChoice[]; skipped: number }
  | { source: CourseSource; status: 'unavailable'; error: CourseworkError };
export function courseKey(course: SelectedCourse): string { return `${course.source}:${course.origin}:${course.id}`; }
export function unavailable(source: CourseSource, code: 'SOURCE_UNAVAILABLE' | 'AUTH_EXPIRED' = 'SOURCE_UNAVAILABLE'): DiscoveryResult {
  return { source, status: 'unavailable', error: new CourseworkError(code, `${source} course discovery unavailable.`) };
}
export function normalizeCanvasCourses(rows: { id: string; name: string; term: string; unpublished?: boolean }[] | null): DiscoveryResult {
  if (rows === null) return unavailable('canvas');
  const accessible = rows.filter(row => !row.unpublished && /^\d+$/.test(row.id));
  return { source: 'canvas', status: 'available', skipped: rows.length - accessible.length,
    courses: accessible.map(row => ({ source: 'canvas', origin: CANVAS_ORIGIN, id: row.id,
      name: row.name.trim() || `Course ${row.id}`, term: { label: row.term.trim() || 'Unspecified term' } })) };
}
export function normalizeEdCourses(entries: unknown): DiscoveryResult {
  if (!Array.isArray(entries)) return unavailable('ed');
  const courses: CourseChoice[] = [];
  for (const entry of entries) {
    const c = entry?.course;
    if (!c || typeof c.status !== 'string') return unavailable('ed');
    if (c.status !== 'active') continue;
    if (!(typeof c.id === 'number' && Number.isSafeInteger(c.id) && c.id > 0 || typeof c.id === 'string' && /^\d+$/.test(c.id))
      || !Number.isInteger(c.year) || typeof c.session !== 'string' || !c.session.trim()
      || typeof c.name !== 'string' || !c.name.trim() || typeof c.code !== 'string') return unavailable('ed');
    courses.push({ source: 'ed', origin: ED_ORIGIN, id: String(c.id), name: c.name, code: c.code,
      term: { year: c.year, session: c.session, label: `${c.year} ${c.session}` } });
  }
  courses.sort((a, b) => b.term.year! - a.term.year! || b.term.session!.localeCompare(a.term.session!, 'en', { numeric: true }));
  return { source: 'ed', status: 'available', courses, skipped: 0 };
}
