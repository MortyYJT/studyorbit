import type { CourseDocument, CourseDocumentV2, CourseModelOutput } from '../../shared/course-data.ts';

export type FrameworkComponent = { name: string; percent: number | null; rowTexts: string[] };
export type RefPlatform = 'canvas' | 'canvas-group' | 'ed' | 'handbook';
export type Ref = { platform: RefPlatform; id: string };
export type CollectedInput = { canvas?: unknown; ed?: unknown; handbook?: unknown };
export type CollectedIndex = {
  assignments: Map<string, Record<string, any>>; groups: Map<string, Record<string, any>>; lessons: Map<string, Record<string, any>>;
  scores: Map<string, Record<string, any>>; handbookUrl: string | null; components: FrameworkComponent[]; componentsByName: Map<string, FrameworkComponent>;
};
export type Facts = { due: string | null; score: number | null; maxScore: number | null; status: 'not_started' | 'submitted' | 'graded' | 'unknown' };
export type Source = { platform: 'canvas' | 'ed' | 'handbook'; url: string | null; evidence: null };

export function normaliseText(value: unknown): string;
export type FrameworkRow = { name: string; percent: number | null; rowText: string; start: number; end: number };
/** The parsers of a framework source (`FrameworkSource` of scripts/institutions/types.d.mts). */
export type FrameworkParsers = { parseRows(text: unknown): FrameworkRow[]; parseComponents(text: unknown): FrameworkComponent[] };
export function slug(value: unknown): string;
export function compareIds(a: string, b: string): number;
export function primaryRef(refs: Ref[], platform: RefPlatform): string | null;
export function generateIds(assessments: Array<{ key: string; parentKey: string | null; refs: Ref[]; name: string }>): { ids: string[]; parentIds: Array<string | null> };
export function indexCollected(collected?: CollectedInput, framework?: FrameworkParsers | null): CollectedIndex;
export function resolveRef(index: CollectedIndex, ref: Ref): Ref | null;
export function canonicalRefs(index: CollectedIndex, refs: Ref[]): Ref[];
export function backfillFacts(index: CollectedIndex, refs: Ref[]): Facts;
export function buildSources(index: CollectedIndex, refs: Ref[]): Source[];
export type PlatformIdentity = { platform: 'canvas' | 'ed'; id: string } | { bare: string };
export function platformIdentities(item: { id?: unknown; refs?: unknown; sources?: unknown }): PlatformIdentity[];
export function buildLegacyIds(
  previous: { version: 1 | 2; assessments: Array<{ id: string; name: string; [key: string]: unknown }>; legacyIds?: Record<string, string> } | null,
  current: { assessments: Array<{ id: string; name: string; refs?: Ref[] }> },
): Record<string, string>;
export function buildStoredDocument(modelDocument: CourseModelOutput, collected: CollectedInput, previous: CourseDocument | null, framework?: FrameworkParsers | null): CourseDocumentV2;
export function renderGroupRules(group: { id?: unknown; rules?: unknown; [key: string]: unknown }, assignments: unknown): string;
