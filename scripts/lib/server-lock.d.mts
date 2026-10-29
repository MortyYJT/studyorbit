export const LOCK_FILE: string;
export const SERVER_RUNNING_MESSAGE: string;
export function acquireServerLock(projectDir: string): { path: string; release(): void };
