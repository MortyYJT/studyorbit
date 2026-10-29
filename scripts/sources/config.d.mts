import type { z } from 'zod';

export const SOURCE_CONFIG_ENV: 'STUDYORBIT_SOURCE_CONFIG';
export const MISSING_CONFIG_OFF_MACOS: string;
export const BROWSER_OVERRIDE_ENV: 'STUDYORBIT_BROWSER';
export function defaultSourceConfig(env?: Record<string, string | undefined>): SourceConfig;
export type SourceConfig = {
  version: 1; institution: 'unimelb'; canvasOrigin: string; browser: 'edge-applescript' | 'chrome-applescript'; browserPath: null; edRegion: 'auto'; profileDir: null;
};
export const SourceConfigSchema: z.ZodType<SourceConfig>;
export const DEFAULT_SOURCE_CONFIG: Readonly<SourceConfig>;
export function canvasOrigin(value: unknown): string;
export function sourceConfigEnv(config: SourceConfig): Record<string, string>;
export function readSourceConfig(options?: { env?: Record<string, string | undefined>; platform?: string; needsBrowser?: boolean }): SourceConfig;
