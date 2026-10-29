import type { Institution } from '../institutions/types.d.mts';
import type { SourceConfig } from './config.mjs';
import type { CollectorCommand, CourseSource, SourceContext } from './types.d.mts';

export function resolveSources(settings: SourceConfig, institution: Institution): CourseSource[];
export const LEGACY_SOURCE_IDS: readonly string[];
export type SourceSetup = { settings: SourceConfig; institution: Institution; sources: CourseSource[]; context: SourceContext };
export function resolveSourceSetup(settings?: SourceConfig): SourceSetup;
export const canvasSource: CourseSource & { discover(ctx: SourceContext, out: string): CollectorCommand };
export const edSource: CourseSource;
