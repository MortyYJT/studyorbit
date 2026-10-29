import type { CourseDocument } from '../../shared/course-data.js';
import type { Institution } from '../institutions/types.d.mts';
export type CourseCandidate = { id: string; name: string; code?: unknown; term?: string | null; subjectCode: string };
export function loadCourseReports(projectDir: string, options?: { desktop?: string; institution?: Institution; canvasOrigin?: string }): Promise<{ courses: CourseCandidate[]; reports: { id: string; report: CourseDocument | null }[] }>;
export function newestCourseDocument(dir: string, courseId: string): Promise<CourseDocument | null>;
