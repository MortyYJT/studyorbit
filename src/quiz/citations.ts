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
// Ignore grammatical overlap, but treat two shared content words as uncertain provenance.
// No similarity percentage: adding unrelated prose must not dilute a material claim.
const grammaticalWords = new Set('a an the is are was were be been being am to of in on at for from with by and or but as if then than this that these those it its my your our their can could may might will would shall should do does did'.split(' '));
const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });
function contentWords(value: string) {
  // Preserve UTF-16 positions while making all punctuation/symbols word boundaries.
  const separated = value.replace(/[\p{P}\p{S}]/gu, char => ' '.repeat(char.length));
  const words = [...wordSegmenter.segment(separated)].filter(segment => segment.isWordLike).map(segment => ({
    word: normalizeCitation(segment.segment).toLocaleLowerCase('en'), start: segment.index, end: segment.index + segment.segment.length,
  })).filter(segment => !grammaticalWords.has(segment.word));
  // Symbols such as logical/mathematical operators are meaningful material too.
  const symbols = [...value.matchAll(/\p{S}/gu)].map(match => ({
    word: normalizeCitation(match[0]), start: match.index, end: match.index + match[0].length,
  }));
  return [...words, ...symbols];
}
function materialSurface(value: string): string {
  const normalized = normalizeCitation(value).toLocaleLowerCase('en');
  return normalized.replace(/[\p{P}\s]/gu, '') || normalized;
}
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
      // Detect across the complete field so splitting a copied claim cannot hide it.
      // Every statement touching the matched words must declare the corresponding source.
      const words = contentWords(answer[field]);
      for (const source of sources.values()) {
        if (source.kind !== 'material') continue;
        // With no interpretable content tokens, exact normalized reuse is still
        // ambiguous provenance: require support rather than silently accepting it.
        if (!contentWords(source.text).length && materialSurface(answer[field]).includes(materialSurface(source.text))
          && statements.some(statement => statement.kind !== 'material' || statement.sourceItemId !== source.sourceItemId)) return mismatch();
        for (const fragment of source.text.split(/[.!?。！？;\n]+/u)) {
          const materialWords = new Set(contentWords(fragment).map(segment => segment.word));
          const matching = words.filter(segment => materialWords.has(segment.word));
          const overlap = new Set(matching.map(segment => segment.word)).size;
          if (overlap < 2 && !(materialWords.size === 1 && overlap === 1)) continue;
          let start = 0;
          for (const statement of statements) {
            const end = start + statement.text.length;
            if (matching.some(segment => segment.start < end && segment.end > start)
              && (statement.kind !== 'material' || statement.sourceItemId !== source.sourceItemId)) return mismatch();
            start = end;
          }
        }
      }
    }
    return { ...answer, validatedCitations, evidence: materialIds.size ? 'course-material' as const : 'prompt-only' as const,
      ...(materialIds.size ? {} : { limitation: 'Question provenance only; not correctness or supporting course-material evidence.' }) };
  });
}
