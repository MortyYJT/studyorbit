import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CitationSchema } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
export const questionRefSchema = z.string().regex(/^ed:[1-9]\d{0,15}:[1-9]\d{0,15}:[1-9]\d{0,15}:[1-9]\d{0,15}$/);
const text = z.string().min(1).max(100000).refine(value => value.trim().length > 0);
const statementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ field: z.enum(['answer', 'rationale']), text, kind: z.literal('reasoning') }),
  z.strictObject({ field: z.enum(['answer', 'rationale']), text, kind: z.literal('material'), sourceItemId: text }),
]);
export const answerSchema = z.strictObject({ questionRef: questionRefSchema, answer: text, rationale: text,
  citations: z.array(CitationSchema.strict().extend({ quote: text })).min(1).max(100), statements: z.array(statementSchema).min(2).max(300) });
export const trustedSourceSchema = z.strictObject({ sourceItemId: text, kind: z.enum(['question', 'material']), questionRef: questionRefSchema.optional(),
  text, locator: text, page: z.number().int().positive().optional() }).refine(source => source.kind === 'question'
    ? source.questionRef === source.sourceItemId && questionRefSchema.safeParse(source.sourceItemId).success
    : source.questionRef === undefined);
export type TrustedSource = z.infer<typeof trustedSourceSchema>;
export function hash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}
export function normalizeCitation(value: string): string { return value.normalize('NFKC').replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'").replace(/\s+/gu, ' ').trim(); }
function mismatch(): never { throw new CourseworkError('CITATION_MISMATCH', 'Citation provenance could not be verified.'); }
/** Map normalized quote positions back to UTF-16 offsets in the original trusted text. */
function quoteOffset(source: string, quote: string): { offset: number; end: number } {
  const wanted = normalizeCitation(quote); const normalized = normalizeCitation(source); const index = normalized.indexOf(wanted);
  if (!wanted || index < 0) return mismatch();
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
  if (projected !== normalized || !positions[index] || !positions[index + wanted.length - 1]) return mismatch();
  return { offset: positions[index].start, end: positions[index + wanted.length - 1].end };
}
export function validateCitedAnswers(input: unknown, questions: readonly string[], trusted: readonly TrustedSource[]) {
  const result = z.array(answerSchema).min(1).max(300).safeParse(input);
  const sourceResult = z.array(trustedSourceSchema).safeParse(trusted);
  if (!result.success || !sourceResult.success) return mismatch();
  const sources = new Map(sourceResult.data.map(source => [source.sourceItemId, source]));
  if (sources.size !== trusted.length || new Set(result.data.map(a => a.questionRef)).size !== result.data.length) return mismatch();
  return result.data.map(answer => {
    if (!questions.includes(answer.questionRef)) return mismatch();
    const validatedCitations = answer.citations.map(citation => {
      const source = sources.get(citation.sourceItemId);
      if (!source || citation.locator !== source.locator || source.page !== undefined && source.locator !== `page:${source.page}`) return mismatch();
      const offsets = quoteOffset(source.text, citation.quote);
      return { ...citation, ...offsets, sourceHash: hash(source.text), ...(source.page ? { page: source.page } : {}) };
    });
    if (!answer.citations.some(c => { const source = sources.get(c.sourceItemId); return source?.kind === 'question' && source.questionRef === answer.questionRef && source.sourceItemId === answer.questionRef; })) return mismatch();
    const materialIds = new Set<string>();
    for (const field of ['answer', 'rationale'] as const) {
      const statements = answer.statements.filter(s => s.field === field);
      if (statements.map(s => s.text).join('') !== answer[field]) return mismatch();
      for (const statement of statements) {
        if (statement.kind !== 'material') continue;
        const source = sources.get(statement.sourceItemId);
        if (source?.kind !== 'material' || !answer.citations.some(c => c.sourceItemId === source.sourceItemId)) return mismatch();
        materialIds.add(source.sourceItemId);
      }
      // Exact reuse of known material cannot be relabelled as prompt-only reasoning.
      for (const source of sources.values()) {
        if (source.kind !== 'material') continue;
        const fragments = source.text.split(/(?<=[.!?])\s+/u).map(normalizeCitation).filter(s => s.length > 0);
        if (fragments.some(s => normalizeCitation(answer[field]).includes(s)) && !statements.some(s => s.kind === 'material' && s.sourceItemId === source.sourceItemId)) return mismatch();
      }
    }
    return { ...answer, validatedCitations, evidence: materialIds.size ? 'course-material' as const : 'prompt-only' as const,
      ...(materialIds.size ? {} : { limitation: 'Question provenance only; not correctness or supporting course-material evidence.' }) };
  });
}
