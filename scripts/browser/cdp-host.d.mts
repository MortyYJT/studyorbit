import type { closeCdpBrowser, startCdpBrowser } from './cdp-launch.mjs';

export const HOST_CLOSING: string;
export const TAB_GONE: string;
/** A collector the host serves: its bridge, browser program and the origins it may open (from the server's configuration). */
export type CdpClient = { browser: string; browserPath: string | null; allowedOrigins: readonly string[] };
/** The part of a child process the host uses: its IPC channel and lifecycle events. */
export type IpcChild = {
  connected: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit' | 'disconnect', listener: () => void): unknown;
};
export type CdpHost = {
  clientFor(commandEnv: Record<string, string | undefined> | undefined): CdpClient | null;
  attach(child: IpcChild, client: CdpClient): () => void;
  openSignIn(options: { browser: string; browserPath: string | null; canvasOrigin: string }): Promise<void>;
  settingsChanged(settings: { browser: string; browserPath: string | null }): Promise<void>;
  shutdown(): Promise<void>;
  running(): boolean;
};
export function createCdpHost(options: {
  projectDir: string; platform?: string; env?: Record<string, string | undefined>;
  start?: typeof startCdpBrowser; close?: typeof closeCdpBrowser;
}): CdpHost;
