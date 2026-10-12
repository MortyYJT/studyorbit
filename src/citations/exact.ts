import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CitationSchema } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
const text = z.string().min(1).max(100000).refine(value => value.trim().length > 0);
const citationSchema = CitationSchema.strict().extend({ quote: text, locator: text });
const evidenceSchema = z.strictObject({ sourceItemId: text, text, locator: text,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().positive().safe().optional() });
export type CitationEvidence = z.infer<typeof evidenceSchema>;
export function citationMismatch(): never {
  throw new CourseworkError('CITATION_MISMATCH', 'Citation provenance could not be verified.');
}
export function hash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}
export function normalizeCitation(value: string): string { return value.normalize('NFKC').replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'").replace(/\s+/gu, ' ').trim(); }
/** Map normalized quote positions back to UTF-16 offsets in the original trusted text. */
function quoteOffset(source: string, quote: string): { offset: number; end: number } {
  const wanted = normalizeCitation(quote); const normalized = normalizeCitation(source); const index = normalized.indexOf(wanted);
  if (!wanted || index < 0) return citationMismatch();
  const positions: { start: number; end: number }[] = []; let projected = ''; let pending: { start: number; end: number } | undefined;
  for (const segment of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(source)) {
    const start = segment.index; const end = start + segment.segment.length;
    const value = segment.segment.normalize('NFKC').replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
    for (const char of value) {
      if (/\s/u.test(char)) { if (projected) pending = pending ? { start: pending.start, end } : { start, end }; continue; }
      if (pending) { projected += ' '; positions.push(pending); pending = undefined; }
      projected += char; for (let i = 0; i < char.length; i++) positions.push({ start, end });
    }
  }
  if (projected !== normalized || !positions[index] || !positions[index + wanted.length - 1]) return citationMismatch();
  return { offset: positions[index].start, end: positions[index + wanted.length - 1].end };
}

/** Validate only membership in host-resolved evidence; never infer logical correctness. */
export function validateCitation(input: unknown, trusted: unknown) {
  const citationResult = citationSchema.safeParse(input); const evidenceResult = evidenceSchema.safeParse(trusted);
  if (!citationResult.success || !evidenceResult.success) return citationMismatch();
  const citation = citationResult.data; const source = evidenceResult.data;
  if (citation.sourceItemId !== source.sourceItemId || citation.locator !== source.locator
    || source.sourceHash !== hash(source.text)
    || source.page !== undefined && source.locator !== `page:${source.page}`) return citationMismatch();
  return { ...citation, ...quoteOffset(source.text, citation.quote), sourceHash: source.sourceHash,
    ...(source.page !== undefined ? { page: source.page } : {}) };
}
