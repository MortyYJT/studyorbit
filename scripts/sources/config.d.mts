import type { z } from 'zod';
import type { InstitutionId } from '../institutions/types.d.mts';

export const SOURCE_CONFIG_ENV: 'STUDYORBIT_SOURCE_CONFIG';
export const MISSING_CONFIG_OFF_MACOS: string;
export type BridgeId = 'edge-applescript' | 'chrome-applescript' | 'cdp-chrome' | 'cdp-edge';
export const BRIDGE_IDS: readonly BridgeId[];
export type EdRegion = 'auto' | 'au' | 'us' | 'eu';
export type SourceConfig = {
  version: 1; institution: InstitutionId; canvasOrigin: string; browser: BridgeId; browserPath: string | null; edRegion: EdRegion; profileDir: null;
};
export const SourceConfigSchema: z.ZodType<SourceConfig>;
export const DEFAULT_SOURCE_CONFIG: Readonly<SourceConfig>;
export function canvasOrigin(value: unknown): string;
export function collectorConfig(settings: { institution: string; canvasOrigin: string | null; browser: string; browserPath?: string | null; edRegion?: string }): SourceConfig;
export function sourceConfigEnv(config: SourceConfig): Record<string, string>;
export function readSourceConfig(options?: { env?: Record<string, string | undefined>; platform?: string; needsBrowser?: boolean }): SourceConfig;
