import type { Institution } from '../institutions/types.d.mts';
import type { SourceConfig } from './config.mjs';
import type { CollectorCommand, CourseSource, SourceContext } from './types.d.mts';

export function resolveSources(settings: unknown, institution: Institution): CourseSource[];
export const LEGACY_SOURCE_IDS: readonly string[];
/** Effective source settings, or a collector configuration (today's setup by default). */
export type SetupSettings = {
  institution: string; canvasOrigin: string | null; browser: string; browserPath?: string | null; edRegion?: string; timeZone?: string | null; codePattern?: string | null;
};
export type SourceSetup = { settings: SourceConfig; institution: Institution; timeZone: string; sources: CourseSource[]; context: SourceContext };
export function resolveSourceSetup(settings?: SetupSettings): SourceSetup;
export const canvasSource: CourseSource & { discover(ctx: SourceContext, out: string): CollectorCommand };
export const edSource: CourseSource;
