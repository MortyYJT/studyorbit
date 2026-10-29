export type RevisionNote = { id: string; courseId: string; title: string; content: string; chatId: string | null; savedAt: string };
export const NOTE_LIMITS: { content: number; perCourse: number };
export function isCourseId(value: unknown): value is string;
export function listNotes(projectDir: string, courseId: string): Promise<RevisionNote[]>;
export function createNote(projectDir: string, input: { courseId: unknown; content: unknown; chatId: unknown }): Promise<RevisionNote>;
export function deleteNote(projectDir: string, id: string): Promise<boolean>;
