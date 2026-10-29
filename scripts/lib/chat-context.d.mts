import type { CourseDocument, DisplayDocument } from '../../shared/course-data.js';
export const CONTEXT_LIMIT: number;
export function buildChatContext(documents: (CourseDocument | DisplayDocument)[], options: { today: string; courseIds?: string[]; courses?: { id: string; code?: string; name?: string }[] }): string;
export function chatSystemPrompt(language?: 'zh' | 'en'): string;
