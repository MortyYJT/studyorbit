import type { CourseDocument } from '../../shared/course-data.js';
export type CourseCandidate = { id: string; name: string; code?: unknown; term?: string | null; subjectCode: string };
export function loadCourseReports(projectDir: string, options?: { desktop?: string }): Promise<{ courses: CourseCandidate[]; reports: { id: string; report: CourseDocument | null }[] }>;
