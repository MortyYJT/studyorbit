import type { Readable, Writable } from 'node:stream';

export const STATE_EXPRESSION: 'document.readyState';
export const CDP_EXPRESSIONS: readonly string[];
export const CDP_COMMAND_TIMEOUT_MS: number;
export const CDP_MAX_FRAME_BYTES: number;
export const PIPE_CLOSED: string;
export const CDP_ALLOWED_METHODS: readonly string[];
export function assertAllowedCommand(method: unknown, params: unknown, sessionId?: string): void;
export type CdpPipe = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  onClose(listener: (error: Error) => void): void;
  closed(): boolean;
  dispose(): void;
};
export function createCdpPipe(options: { input: Readable; output: Writable; timeoutMs?: number; maxFrameBytes?: number }): CdpPipe;
