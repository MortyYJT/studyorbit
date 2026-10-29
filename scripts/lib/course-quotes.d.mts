import type { CourseDocumentV2 } from '../../shared/course-data.ts';
import type { CollectedInput } from './course-refs.mjs';

export type QuoteUnit = { text: string; name: string | null };

export function normaliseText(value: unknown): string;
export function quoteCorpus(collected?: CollectedInput): QuoteUnit[];
export function quoteFound(corpus: QuoteUnit[], quote: unknown): QuoteUnit[];
export function verifyQuotes(document: CourseDocumentV2, collected: CollectedInput): { document: CourseDocumentV2; cleared: number };
