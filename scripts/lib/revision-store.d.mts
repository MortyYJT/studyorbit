export type RevisionNote = { id: string; courseId: string; title: string; content: string; chatId: string | null; savedAt: string };
export function listNotes(projectDir: string, courseId: string): Promise<RevisionNote[]>;
export function deleteNote(projectDir: string, id: string): Promise<boolean>;
