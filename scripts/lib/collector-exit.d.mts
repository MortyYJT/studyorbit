export const EX_TEMPFAIL: 75;
export function isTemporaryStatus(status: unknown): boolean;
export function httpFailure(label: string, status: number): Error & { status: number; temporary: boolean };
export function cliFailureIsTemporary(error: unknown): boolean;
export function collectorExitCode(error: unknown): 1 | 75;
