import type { BrowserBridge } from './bridge.mjs';

export type OsascriptRunner = (script: string, args: string[]) => Promise<string>;
export const APPLESCRIPT_APPS: Readonly<Record<string, string>>;
export function appleEventsHint(id: string): string;
export function runningScript(app: string): string;
export function runOsascript(script: string, args: string[]): Promise<string>;
export function appleScripts(app: string): Record<'create' | 'status' | 'same-origin-json' | 'body-text' | 'navigation-status' | 'close', string>;
export function createAppleScriptBridge(options: { id: string; allowedOrigins: readonly string[]; runner?: OsascriptRunner; platform?: string }): BrowserBridge;
