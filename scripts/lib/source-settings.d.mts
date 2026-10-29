import type { BridgeId, EdRegion } from '../sources/config.mjs';
import type { SourceSetup } from '../sources/registry.mjs';
import type { InstitutionId } from '../institutions/types.d.mts';

export type SourceSettings = {
  version: 1; institution: InstitutionId; canvasOrigin: string | null; browser: BridgeId; browserPath: string | null;
  edRegion: EdRegion; timeZone: string | null; codePattern: string | null;
};
/** Settings in effect: the Canvas origin and time zone are always filled in. */
export type EffectiveSourceSettings = SourceSettings & { canvasOrigin: string | null; timeZone: string };
export type BrowserInfo = { label: { zh: string; en: string }; platforms: readonly string[] | null; experimental: boolean; implemented: boolean };
export type AvailableChoices = {
  institutions: { id: InstitutionId; label: { zh: string; en: string }; defaultCanvasOrigin: string | null; fixedTimeZone: string | null; frameworkLabel: string | null }[];
  browsers: { id: BridgeId; label: { zh: string; en: string }; experimental: boolean; implemented: boolean; available: boolean }[];
  edRegions: EdRegion[];
};

export const SOURCE_SETTINGS_VERSION: 1;
export const ED_REGIONS: readonly EdRegion[];
export const BROWSERS: Readonly<Record<BridgeId, BrowserInfo>>;
export function sourceSettingsFile(projectDir: string): string;
export class SourceSettingsError extends Error {
  code: 'INVALID_SOURCE_SETTINGS' | 'SOURCE_SETTINGS_UNREADABLE' | 'SYNC_RUNNING' | (string & {}); field: string | null; reason: string;
  constructor(code: string, field?: string | null, reason?: string);
}
export function systemTimeZone(): string;
export function browserAvailable(browser: string, platform: string): boolean;
export function canonicalTimeZone(value: unknown): string | null;
export function defaultSourceSettings(platform?: string): SourceSettings;
export function validateSourceSettings(input: unknown, options?: { platform?: string; isFile?: (path: string) => Promise<boolean> }): Promise<SourceSettings>;
export function isExistingFile(path: string): Promise<boolean>;
export function loadSourceSettings(projectDir: string, options?: { platform?: string }): Promise<{ settings: SourceSettings; saved: boolean }>;
export function saveSourceSettings(projectDir: string, input: unknown, options?: { platform?: string; isFile?: (path: string) => Promise<boolean>; beforeWrite?: () => void }): Promise<SourceSettings>;
export function effectiveSourceSettings(settings: SourceSettings): EffectiveSourceSettings;
export function availableChoices(platform?: string): AvailableChoices;
export function loadSourceSetup(projectDir: string, options?: { platform?: string }): Promise<SourceSetup>;
