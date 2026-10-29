import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CourseChange } from '../../shared/course-changes.js';
import type { CourseDocument } from '../../shared/course-data.js';

export type CourseChangesEntry = { at: string; runId: string; courseId: string; previous: CourseDocument | null; current: CourseDocument };
export const CHANGE_LOG_LIMIT: number;
export function appendCourseChanges(projectDir: string, entry: CourseChangesEntry): Promise<number>;
export function recordCourseChanges(projectDir: string, entry: CourseChangesEntry, row: { reason: string }): Promise<void>;
export function readCourseChanges(projectDir: string, limit?: number): Promise<CourseChange[]>;
export function createCourseChangesHandler(projectDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
