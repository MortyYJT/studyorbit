import type { CourseDocument, DisplayDocument } from '../../shared/course-data.js';
import type { Institution } from '../institutions/types.d.mts';
export function toolSystemPrompt(language?: 'zh' | 'en', institution?: Institution): string;
export function buildCourseIndex(input: {
  documents: (CourseDocument | DisplayDocument)[];
  courses: { id: string; code?: string; name?: string }[];
  scope: string[];
  today: string;
  planning: { tasks: unknown[]; omitted?: number } | null;
  institution?: Institution;
}): string;
