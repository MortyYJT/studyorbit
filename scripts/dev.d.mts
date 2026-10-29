export const LISTENING_PREFIX: string;
export const START_TIMEOUT_MS: number;
type Command = { command: string; args: string[] };
export function startLauncher(options: {
  server: Command; web: Command; env: Record<string, string | undefined>; cwd?: string;
  out?: { write(chunk: string): unknown }; log?: (line: string) => void; startTimeoutMs?: number;
}): { done: Promise<number>; signal(name: NodeJS.Signals): void };
