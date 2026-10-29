import type { CourseDocument, CourseDocumentV2, CourseModelOutput } from '../../shared/course-data.ts';

export type HandbookComponent = { name: string; percent: number | null; rowTexts: string[] };
export type RefPlatform = 'canvas' | 'canvas-group' | 'ed' | 'handbook';
export type Ref = { platform: RefPlatform; id: string };
export type CollectedInput = { canvas?: unknown; ed?: unknown; handbook?: unknown };
export type CollectedIndex = {
  assignments: Map<string, Record<string, any>>; groups: Map<string, Record<string, any>>; lessons: Map<string, Record<string, any>>;
  scores: Map<string, Record<string, any>>; handbookUrl: string | null; components: HandbookComponent[]; componentsByName: Map<string, HandbookComponent>;
};
export type Facts = { due: string | null; score: number | null; maxScore: number | null; status: 'not_started' | 'submitted' | 'graded' | 'unknown' };
export type Source = { platform: 'canvas' | 'ed' | 'handbook'; url: string | null; evidence: null };

export function normaliseText(value: unknown): string;
export function parseHandbookComponents(text: unknown): HandbookComponent[];
export function slug(value: unknown): string;
export function compareIds(a: string, b: string): number;
export function primaryRef(refs: Ref[], platform: RefPlatform): string | null;
export function generateIds(assessments: Array<{ key: string; parentKey: string | null; refs: Ref[]; name: string }>): { ids: string[]; parentIds: Array<string | null> };
export function indexCollected(collected?: CollectedInput): CollectedIndex;
export function resolveRef(index: CollectedIndex, ref: Ref): Ref | null;
export function canonicalRefs(index: CollectedIndex, refs: Ref[]): Ref[];
export function backfillFacts(index: CollectedIndex, refs: Ref[]): Facts;
export function buildSources(index: CollectedIndex, refs: Ref[]): Source[];
export function buildLegacyIds(
  previous: { version: 1 | 2; assessments: Array<{ id: string; name: string; [key: string]: unknown }>; legacyIds?: Record<string, string> } | null,
  current: { assessments: Array<{ id: string; name: string; refs?: Ref[] }> },
): Record<string, string>;
export function buildStoredDocument(modelDocument: CourseModelOutput, collected: CollectedInput, previous: CourseDocument | null): CourseDocumentV2;
export function renderGroupRules(group: { id?: unknown; rules?: unknown; [key: string]: unknown }, assignments: unknown): string;
