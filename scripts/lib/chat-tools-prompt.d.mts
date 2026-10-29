import type { CourseDocument, DisplayDocument } from '../../shared/course-data.js';
export function toolSystemPrompt(language?: 'zh' | 'en'): string;
export function buildCourseIndex(input: {
  documents: (CourseDocument | DisplayDocument)[];
  courses: { id: string; code?: string; name?: string }[];
  scope: string[];
  today: string;
  planning: { tasks: unknown[]; omitted?: number } | null;
}): string;
