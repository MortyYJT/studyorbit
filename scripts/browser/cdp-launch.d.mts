import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { CdpPipe } from './cdp-pipe.mjs';

export type CdpBridgeId = 'cdp-chrome' | 'cdp-edge';
export type SpawnLike = (file: string, args: string[], options: SpawnOptions & { stdio: unknown[] }) => ChildProcess;
export type ProfileFs = {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
};
export const CDP_BROWSERS: Readonly<Record<CdpBridgeId, { label: string; windows: string; linux: readonly string[]; darwin: readonly string[] }>>;
export const PROFILE_IN_USE: string;
export const START_TIMEOUT_MS: number;
export const KILL_AFTER_MS: number;
export function findBrowserExecutable(options: {
  id: string; browserPath: string | null; platform?: string; env?: Record<string, string | undefined>; isFile?: (path: string) => Promise<boolean>;
}): Promise<string>;
export function profileDirFor(projectDir: string, id: string, platform?: string): string;
export function launchArgs(profileDir: string, extraArgs?: string[]): string[];
export function ensureProfileDir(dir: string, options?: { platform?: string; fs?: ProfileFs }): Promise<void>;
export function profileLockFile(profileDir: string, platform: string): string;
export type StartedBrowser = {
  id: string; browserPath: string | null; pipe: CdpPipe; child: ChildProcess;
  exited: Promise<{ code: number | null; signal: string | null; error: Error | null }>; running(): boolean;
};
export type StartOptions = {
  id: string; projectDir: string; browserPath?: string | null; platform?: string; env?: Record<string, string | undefined>;
  isFile?: (path: string) => Promise<boolean>; fs?: ProfileFs; spawn?: SpawnLike; lockExists?: (path: string) => Promise<boolean>;
  startTimeoutMs?: number; exitGraceMs?: number; extraArgs?: string[];
};
export function startCdpBrowser(options: StartOptions): Promise<StartedBrowser>;
export function closeCdpBrowser(started: StartedBrowser, options?: { killAfterMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<void>;
