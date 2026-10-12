import { z } from 'zod';
import { CitationSchema } from '../domain/schemas.js';
import { hash, normalizeCitation, validateCitation, citationMismatch as mismatch } from '../citations/exact.js';
export { hash, normalizeCitation } from '../citations/exact.js';
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
const MATERIAL_SOURCE = String.raw`(?:notes?|slides?|lectures?|readings?|textbook|handouts?|(?:course\s+)?materials?|lecturer|tutor)`;
const MATERIAL_ATTRIBUTION = new RegExp(String.raw`\b(?:the\s+)?${MATERIAL_SOURCE}\s+(?:say|says|said|state[sd]?|show[sn]?|mention(?:s|ed)?|note[sd]?|indicate[sd]?|explain(?:s|ed)?)\b`
  + String.raw`|\baccording\s+to\s+(?:the\s+)?${MATERIAL_SOURCE}\b`
  + '|(?:课件|讲义|笔记|课程材料|幻灯片|教材|讲座)(?:里|中|上)?(?:说|提到|写|指出|讲)|根据(?:课件|讲义|笔记|课程材料|幻灯片|教材|讲座)', 'iu');
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
      if (!source) return mismatch();
      // Q1's trusted file adapter owns course/question binding. Keep its v1 source shape.
      return validateCitation(citation, { sourceItemId: source.sourceItemId, text: source.text,
        locator: source.locator, sourceHash: hash(source.text), ...(source.page !== undefined ? { page: source.page } : {}) });
    });
    if (!answer.citations.some(c => { const source = sources.get(c.sourceItemId); return source?.kind === 'question' && source.questionRef === answer.questionRef && source.sourceItemId === answer.questionRef; })) return mismatch();
    // A material statement may declare any cited material that contains the matched fragment,
    // so a sentence duplicated across materials does not have to name every copy.
    const supports = (statement: { kind: string; sourceItemId?: string }, source: TrustedSource, fragment: string) => {
      if (statement.kind !== 'material' || !statement.sourceItemId) return false;
      if (statement.sourceItemId === source.sourceItemId) return true;
      const declared = sources.get(statement.sourceItemId);
      return declared?.kind === 'material' && answer.citations.some(c => c.sourceItemId === declared.sourceItemId)
        && !!materialSurface(fragment) && materialSurface(declared.text).includes(materialSurface(fragment));
    };
    const materialIds = new Set<string>();
    for (const field of ['answer', 'rationale'] as const) {
      const statements = answer.statements.filter(s => s.field === field);
      if (statements.map(s => s.text).join('') !== answer[field]) return mismatch();
      // Check attribution on the complete field: statement splits cannot hide #84.
      for (const match of answer[field].matchAll(new RegExp(MATERIAL_ATTRIBUTION.source, 'giu'))) {
        let start = 0;
        for (const statement of statements) {
          const end = start + statement.text.length;
          if (start < match.index + match[0].length && end > match.index && statement.kind !== 'material') return mismatch();
          start = end;
        }
      }
      for (const statement of statements) {
        // Paraphrase cannot be detected deterministically, but an explicit attribution to
        // course material ("the notes say", "根据课件") must carry a material citation.
        if (statement.kind !== 'material' && MATERIAL_ATTRIBUTION.test(statement.text)) return mismatch();
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
              && !supports(statement, source, fragment)) return mismatch();
            start = end;
          }
        }
      }
    }
    return { ...answer, validatedCitations, evidence: materialIds.size ? 'course-material' as const : 'prompt-only' as const,
      ...(materialIds.size ? {} : { limitation: 'Question provenance only; not correctness or supporting course-material evidence.' }) };
  });
}
