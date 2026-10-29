import type { CourseDocument, DisplayDocument } from '../../shared/course-data.js';
import type { Institution } from '../institutions/types.d.mts';
export const CONTEXT_LIMIT: number;
export function buildChatContext(documents: (CourseDocument | DisplayDocument)[], options: { today: string; courseIds?: string[]; courses?: { id: string; code?: string; name?: string }[]; institution?: Institution; timeZone?: string }): string;
export function chatSystemPrompt(language?: 'zh' | 'en', mode?: 'context' | 'tools', institution?: Institution): string;
