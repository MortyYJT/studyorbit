import type { BrowserBridge } from './bridge.mjs';

export const CDP_BRIDGE_IDS: readonly ['cdp-chrome', 'cdp-edge'];
export const CDP_NEEDS_SERVER: string;
export const CDP_SIGN_IN: string;
export const CDP_REQUEST_TIMEOUT_MS: number;
/** The collector's end of the IPC channel (its `process`). */
export type IpcChannel = {
  connected: boolean;
  send(message: unknown): boolean;
  disconnect(): void;
  on(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
  off(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
};
export function createCdpBridge(options: { id: string; allowedOrigins: readonly string[]; channel?: IpcChannel; timeoutMs?: number }): BrowserBridge;
