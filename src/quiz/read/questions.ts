import { z } from 'zod';
import { CourseworkError } from '../../protocol/errors.js';
import { edId, targetSchema } from './contracts.js';
import { sourceUnavailable, type QuizPayload } from './adapter.js';
const id = z.union([edId, z.number().int().positive().safe().transform(String)]);
const rawQuestion = z.object({ id, type: z.string().min(1) });
const rawSlide = z.object({ slide: z.object({ id, questions: z.array(rawQuestion).max(300) }) });
const option = z.strictObject({ id: edId, text: z.string().min(1) });
const safeQuestion = z.discriminatedUnion('supported', [
  z.strictObject({ ref: z.string(), supported: z.literal(true), type: z.enum(['text', 'multiple-choice']), prompt: z.string().min(1), options: z.array(option).optional() }),
  z.strictObject({ ref: z.string(), supported: z.literal(false), type: z.literal('unsupported') }),
]);
export const quizOutputSchema = z.strictObject({ assessmentRef: z.string(), questions: z.array(safeQuestion),
  sources: z.array(z.strictObject({ sourceItemId: z.string(), locator: z.string(), text: z.string().min(1) })),
  coverage: z.strictObject({ complete: z.boolean(), scope: z.enum(['assessment', 'selection']), total: z.number().int().nonnegative(),
    supported: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative() }),
});
export type QuizReadData = z.infer<typeof quizOutputSchema>;
/** Projection is deliberately limited to synthetic plain-text contracts until live structure verification. */
export function normalizeQuiz(payload: QuizPayload): QuizReadData {
  const target = targetSchema.safeParse(payload.target);
  const lesson = z.object({ lesson: z.object({ id, slides: z.array(z.object({ id })).max(300) }) }).safeParse(payload.lesson);
  if (!target.success || !lesson.success || lesson.data.lesson.id !== target.data.lesson) throw sourceUnavailable();
  const names = new Set<string>(); const identifiers = new Set<string>(); let nodes = 0;
  const collect = (value: unknown, depth = 0, person = false, nameString = false): void => {
    if (++nodes > 20000 || depth > 30) throw sourceUnavailable();
    if (nameString && typeof value === 'string' && value.trim()) names.add(value.normalize('NFKC').trim());
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1, person, nameString); }
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (person && typeof item === 'string' && !/^(?:name|full_?name|display_?name|first_?name|last_?name|id|email|phone|student_?number|avatar|username|answers?|grades?|solutions?)$/i.test(key)) throw sourceUnavailable();
        const personField = /^(?:authors?|people|students?|classmates?|users?|profiles?|owners?|created_by|updated_by)$/i.test(key);
        const nameField = /^(?:name|full_?name|display_?name|first_?name|last_?name)$/i.test(key);
        if (person && /^(?:username|student_?number)$/i.test(key)) {
          const identity = typeof item === 'number' && /^student_?number$/i.test(key) && Number.isSafeInteger(item) && item > 0 ? String(item) : item;
          if (typeof identity !== 'string' || !identity.trim() || identity.length > 1_000_000 || /[<>\p{C}]/u.test(identity)) throw sourceUnavailable();
          identifiers.add(identity.normalize('NFKC').trim());
          continue;
        }
        collect(item, depth + 1, person || personField, personField || person && nameField);
      }
    }
  };
  collect(payload.lesson); for (const slide of payload.slides) collect(slide);
  const identityPatterns = [...new Set([...names, ...identifiers])].sort((a, b) => b.length - a.length).map(identity => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Known identifiers and Han names must also match inside unspaced text.
    return identifiers.has(identity) || /\p{Script=Han}/u.test(identity)
      ? new RegExp(escaped, 'giu')
      : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  });
  const clean = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1_000_000) throw sourceUnavailable();
    let text = value.normalize('NFKC');
    // Markup, control characters and credential markers cannot be safely interpreted as plain text.
    if (/[<>\u0000-\u0008\u000b-\u001f\u007f]|authToken|x-token|authorization|\b(?:password|csrf|access_token)\b/i.test(text)) throw sourceUnavailable();
    for (const pattern of identityPatterns) text = text.replace(pattern, '[redacted]');
    text = text.split(/(\s+)/u).map(part => part.includes('@') ? '[redacted]' : part).join('')
      .replace(/(?:\+?\d[\d ()-]{6,}\d)/g, '[redacted]');
    // Later replacements must not reintroduce a known identity (even in the marker).
    for (const pattern of identityPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) throw sourceUnavailable();
    }
    if (/\b(?:classmate|student|author|user)\s+(?!(?:\[redacted\]|number\b|id\b))\p{L}+/iu.test(text)) throw sourceUnavailable();
    return text.trim();
  };
  const questions: QuizReadData['questions'] = []; const sources: QuizReadData['sources'] = [];
  const seen = new Set<string>(); const slideIds = new Set<string>();
  const wanted = target.data.questions ? new Set(target.data.questions) : undefined;
  const expectedSlides = lesson.data.lesson.slides.map(s => s.id);
  if (new Set(expectedSlides).size !== expectedSlides.length) throw sourceUnavailable();
  for (const body of payload.slides) {
    const parsed = rawSlide.safeParse(body);
    if (!parsed.success || !expectedSlides.includes(parsed.data.slide.id) || slideIds.has(parsed.data.slide.id)) throw sourceUnavailable();
    slideIds.add(parsed.data.slide.id);
    const raw = (body as { slide: { questions: Record<string, unknown>[] } }).slide.questions;
    for (let i = 0; i < parsed.data.slide.questions.length; i++) {
      const q = parsed.data.slide.questions[i]; const original = raw[i];
      const ref = `ed:${target.data.course}:${target.data.lesson}:${parsed.data.slide.id}:${q.id}`;
      if (seen.has(ref)) throw sourceUnavailable(); seen.add(ref);
      if (wanted && !wanted.has(ref)) continue;
      if (!['text', 'multiple-choice'].includes(q.type)) {
        questions.push({ ref, supported: false, type: 'unsupported' }); continue;
      }
      const prompt = clean(original.prompt);
      const type = q.type as 'text' | 'multiple-choice';
      let options: z.infer<typeof option>[] | undefined;
      if (type === 'multiple-choice') {
        const parsedOptions = z.array(z.object({ id, text: z.unknown() })).min(2).max(100).safeParse(original.options);
        if (!parsedOptions.success || new Set(parsedOptions.data.map(o => o.id)).size !== parsedOptions.data.length) throw sourceUnavailable();
        options = parsedOptions.data.map(o => ({ id: o.id, text: clean(o.text) }));
      }
      questions.push({ ref, supported: true, type, prompt, ...(options ? { options } : {}) });
      sources.push({ sourceItemId: ref, locator: `question:${q.id}`, text: [prompt, ...(options?.map(o => `${o.id}: ${o.text}`) ?? [])].join('\n') });
    }
  }
  if (wanted && [...wanted].some(ref => !seen.has(ref))) throw new CourseworkError('NOT_FOUND', 'Question reference was not discovered.');
  if (!wanted && expectedSlides.some(id => !slideIds.has(id)) || !questions.length) throw sourceUnavailable();
  const supported = questions.filter(q => q.supported).length;
  const output = quizOutputSchema.safeParse({ assessmentRef: `ed:${target.data.course}:${target.data.lesson}`, questions, sources,
    coverage: { complete: supported === questions.length, scope: wanted ? 'selection' : 'assessment', total: questions.length, supported, unsupported: questions.length - supported } });
  if (!output.success) throw sourceUnavailable();
  return output.data;
}
