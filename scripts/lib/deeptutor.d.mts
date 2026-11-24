import type { spawn } from 'node:child_process';

export const DEEPTUTOR_VERSION: string;
export const DEEPSEEK_UPSTREAM: string;
export const PROXY_TOKEN_ENV: string;
export type AssistantPorts = { web: number; api: number; proxy: number };
export type Install = { bin: string; python: string; version: string | null; solve: boolean };
export type AssistantStatus =
  | { state: 'off' | 'starting' | 'not-installed' | 'unsupported-provider' }
  | { state: 'running' | 'external'; url: string; warning?: string }
  | { state: 'failed'; reason: string };
type Env = Record<string, string | undefined>;
export function assistantPorts(env: Env, webPort: number): AssistantPorts;
export function locateInstall(env: Env, home?: string): Install | null;
export function installWarning(install: Install): string | null;
export function setupProfile(options: { model: string; ports: AssistantPorts }): Record<string, Record<string, unknown>>;
export function mergeMcpConfig(existing: unknown, options: { node: string; projectDir: string; desktopDir?: string }): { servers: Record<string, any> };
export function restrictSystemSettings(existing: unknown): Record<string, unknown>;
export function disableWebSearch(yaml: string): string;
export function childEnv(env: Env, extra?: Record<string, string>): Record<string, string>;
export function apiCommand(options: { python: string; port: number }): string[];
export function guardEnv(options: { ports: AssistantPorts; webPort: number }): Record<string, string>;
export function createAssistant(options: {
  projectDir: string; desktopDir?: string; webPort: number; env?: Env; home?: string;
  createProxy(options: { token: string; upstream: string }): { listen(port: number): Promise<number>; close(): Promise<void> };
  log?: (line: string) => void; node?: string; spawn?: typeof spawn; WebSocketImpl?: unknown;
  readyTimeoutMs?: number; killAfterMs?: number; turnTimeoutMs?: number;
}): {
  start(): Promise<void>;
  status(): AssistantStatus;
  startTurn(input: { content: string; language: 'zh' | 'en' }): Promise<{ sessionId: string }>;
  stop(): Promise<void>;
};
