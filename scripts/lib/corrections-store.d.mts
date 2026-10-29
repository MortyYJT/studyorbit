import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CorrectionsView } from '../../shared/corrections.js';
import type { CourseDocument } from '../../shared/course-data.js';

export class CorrectionsError extends Error {
  code: string;
  current?: CorrectionsView;
  constructor(code: string, current?: CorrectionsView);
}
export type CorrectionsStore = {
  list(): Promise<{ courses: Record<string, CorrectionsView | { error: 'CORRECTIONS_UNREADABLE' }> }>;
  read(courseId: string): Promise<CorrectionsView>;
  save(courseId: string, body: unknown): Promise<CorrectionsView>;
  importCourse(courseId: string, body: unknown): Promise<{ imported: false } | { imported: true; store: CorrectionsView }>;
};
export function createCorrectionsStore(options: { projectDir: string; loadDocument: (courseId: string) => Promise<CourseDocument | null>; now?: () => Date }): CorrectionsStore;
export function createCorrectionsHandler(store: CorrectionsStore): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
