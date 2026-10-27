export type CourseSyncRow = { id: string; code: string; status: string; reason: string; file?: string };
export type CourseSyncState = { running: boolean; courses: CourseSyncRow[]; error: string | null };
export function createCourseSyncRunner(projectDir: string): { start(ids: string[]): Promise<CourseSyncState>; status(): CourseSyncState };
