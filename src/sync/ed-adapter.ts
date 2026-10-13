import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readEdScope, type EdReader, type EdOutcome } from './ed-reader.js';
import type { EdSnapshot } from '../capture/ed-transport.js';
import { ED_ORIGIN } from '../capture/ed-transport.js';
import { validateEdScope } from './ed-scope.js';
import { SourceItemSchema, CitationSchema, type SourceItem } from '../domain/schemas.js';
import { edId } from '../protocol/policy.js';
import { normalizeEdQuestions } from './ed-questions.js';
import { redactNormalizedSources } from './privacy-boundary.js';
import { createRedactor } from './redaction.js';
import { CourseworkError } from '../protocol/errors.js';
const id = z.union([edId, z.number().int().positive().safe().transform(String)]);
const row = z.object({ id }).passthrough();
const list = (key: string) => z.object({ [key]: z.array(row).max(300) }).passthrough();
const lessons = z.object({ lessons: z.array(row.extend({ kind: z.string() })).max(300) }).passthrough();
const detail = z.object({ lesson: row.extend({ slides: z.array(row).max(300) }) }).passthrough();
const slide = z.object({ slide: row.extend({ questions: z.array(row.extend({ type: z.string() })).max(300) }) }).passthrough();
const courses = z.array(z.object({ course: row })).max(300);
export type SyncGap = { scopeRef: string; code: 'SOURCE_UNAVAILABLE' | 'AUTH_EXPIRED' | 'INCOMPLETE' | 'UNSUPPORTED' };
export const scopeHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const sourceIdentity = (provider: 'canvas' | 'ed', origin: string, course: string, external: string): string =>
  `${provider}:${scopeHash(`${provider}:${origin}:${course}:${external}`)}`;
/** Read-only adapter output. No database writes, raw payloads or profiles escape this function. */
export async function syncEd(options: {
  selection: unknown; transport: EdReader; snapshot?: EdSnapshot; fetchedAt: string; rules?: unknown;
}): Promise<{ sources: SourceItem[]; citations: z.infer<typeof CitationSchema>[]; assessments: never[]; gaps: SyncGap[]; status: EdOutcome['status'] }> {
  const selection = validateEdScope(options.selection);
  createRedactor([], options.rules);
  if (!z.iso.datetime({ offset: true }).safeParse(options.fetchedAt).success) throw new CourseworkError('INVALID_INPUT', 'Invalid sync time.');
  const bodies = new Map<string, Record<string, unknown>>();
  const owner = new Map<string, string>();
  const selected = new Set(selection.courses.filter(c => c.source === 'ed').map(c => c.id));
  const gaps: SyncGap[] = [];
  const gap = (endpoint: string, code: SyncGap['code']) => gaps.push({ scopeRef: scopeHash(`ed:${ED_ORIGIN}:${endpoint}`), code });
  const transport: EdReader = { read: async (endpoint, snapshotOptions) => {
    const response = await options.transport.read(endpoint, snapshotOptions);
    if (response.kind !== 'json') return response;
    const course = endpoint.match(/^\/api\/courses\/(\d+)\//)?.[1] ?? owner.get(endpoint);
    if (endpoint === '/api/user') {
      const parsed = courses.safeParse(response.body);
      if (!parsed.success) return { kind: 'gap', reason: 'invalidJson' };
      bodies.set(endpoint, { courses: parsed.data.filter(r => selected.has(r.course.id)) });
      return response;
    }
    const schema = endpoint.endsWith('/lessons') ? lessons : endpoint.includes('/slides/') ? slide
      : endpoint.startsWith('/api/lessons/') ? detail : endpoint.includes('/threads?') ? list('threads') : list('resources');
    const parsed = schema.safeParse(response.body);
    if (!parsed.success || !course || !selected.has(course)) return { kind: 'gap', reason: 'invalidJson' };
    const body = parsed.data as Record<string, unknown>;
    const rows = (body.lessons ?? body.threads ?? body.resources) as { id: string; kind?: string }[] | undefined;
    if (rows && new Set(rows.map(r => r.id)).size !== rows.length) return { kind: 'gap', reason: 'invalidJson' };
    if (endpoint.endsWith('/lessons')) {
      for (const r of rows ?? []) if (r.kind === 'attempt') {
        const path = `/api/lessons/${r.id}`;
        if (owner.has(path) && owner.get(path) !== course) return { kind: 'gap', reason: 'invalidJson' };
        owner.set(path, course);
      }
    } else if (endpoint.startsWith('/api/lessons/')) {
      const r = (body.lesson ?? body.slide) as { id: string; slides?: { id: string }[] };
      if (r.id !== endpoint.split('/').at(-1)) return { kind: 'gap', reason: 'invalidJson' };
      if (r.slides) {
        if (new Set(r.slides.map(s => s.id)).size !== r.slides.length) return { kind: 'gap', reason: 'invalidJson' };
        if (r.slides.some(s => owner.has(`/api/lessons/slides/${s.id}`) && owner.get(`/api/lessons/slides/${s.id}`) !== course)) return { kind: 'gap', reason: 'invalidJson' };
        for (const s of r.slides) owner.set(`/api/lessons/slides/${s.id}`, course);
      }
    }
    owner.set(endpoint, course); bodies.set(endpoint, body);
    return { ...response, body };
  } };
  const outcome = await readEdScope({ courses: selection.courses, transport, snapshot: options.snapshot ?? (async () => {}) });
  for (const g of outcome.gaps) gap(g.endpoint, g.reason === 'auth' ? 'AUTH_EXPIRED' : 'SOURCE_UNAVAILABLE');
  const redactor = createRedactor([...bodies.values()], options.rules);
  const sources: SourceItem[] = []; const citations: z.infer<typeof CitationSchema>[] = [];
  const add = (course: string, external: string, kind: SourceItem['kind'], title: string, text: string, endpoint: string, fixedId?: string) => {
    title = redactor.text(title); text = redactor.text(text);
    const source = SourceItemSchema.parse({ id: fixedId ?? sourceIdentity('ed', ED_ORIGIN, course, external), platform: 'ed', externalId: external,
      courseId: sourceIdentity('ed', ED_ORIGIN, course, 'course'), kind, title, text,
      url: `${ED_ORIGIN}${endpoint}`, contentHash: scopeHash(`${title}\n${text}`), fetchedAt: options.fetchedAt });
    sources.push(source); citations.push(CitationSchema.parse({ sourceItemId: source.id, quote: text, locator: endpoint }));
  };
  for (const [endpoint, body] of bodies) {
    const course = owner.get(endpoint);
    if (!course) continue;
    if (body.lessons) for (const r of body.lessons as Record<string, unknown>[]) {
      if (typeof r.title === 'string') add(course, `lesson:${r.id}`, 'assignment', r.title, `title: ${r.title}`, endpoint);
      if (r.kind === 'attempt') gap(endpoint, 'UNSUPPORTED');
    }
    if (body.threads || body.resources) {
      const kind = body.threads ? 'post' : 'material';
      for (const r of (body.threads ?? body.resources) as Record<string, unknown>[]) {
        if (typeof r.title !== 'string' || body.threads && typeof r.content !== 'string') { gap(endpoint, 'UNSUPPORTED'); continue; }
        add(course, `${body.threads ? 'thread' : 'resource'}:${r.id}`, kind, r.title,
          `title: ${r.title}${typeof r.content === 'string' ? `\ncontent: ${r.content}` : ''}${typeof r.url === 'string' ? `\nurl: ${r.url}` : ''}`, endpoint);
      }
      if (body.threads) gap(endpoint, 'INCOMPLETE');
    }
    if (body.lesson) {
      const lesson = body.lesson as { id: string; slides: { id: string }[] };
      const raw = body.lesson as Record<string, unknown>;
      const fields: [string, string][] = [];
      if (typeof raw.title === 'string') fields.push(['title', raw.title]);
      const dueKey = Object.hasOwn(raw, 'effective_due_at') ? 'effective_due_at' : 'due_at';
      if (Object.hasOwn(raw, dueKey)) {
        if (raw[dueKey] === null) fields.push([dueKey, 'null']);
        else if (z.iso.datetime({ offset: true }).safeParse(raw[dueKey]).success) fields.push([dueKey, new Date(raw[dueKey] as string).toISOString()]);
        else gap(endpoint, 'UNSUPPORTED');
      }
      if (typeof raw.submitted === 'boolean') fields.push(['submitted', String(raw.submitted)]);
      if (['not_started', 'in_progress', 'submitted', 'graded'].includes(raw.status as string)) fields.push(['status', raw.status as string]);
      for (const key of ['score', 'max_score']) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) fields.push([key, String(raw[key])]);
      if (typeof raw.score === 'number' && Number.isFinite(raw.score) && typeof raw.max_score === 'number' && Number.isFinite(raw.max_score)
        && raw.max_score > 0 && raw.score >= 0 && raw.score <= raw.max_score) fields.push(['percentage', String(100 * raw.score / raw.max_score)]);
      else if (Object.hasOwn(raw, 'score')) gap(endpoint, 'UNSUPPORTED');
      if (fields.length) {
        const text = fields.map(([key, value]) => `${key}: ${value}`).join('\n');
        add(course, `attempt:${lesson.id}`, 'assignment', typeof raw.title === 'string' ? raw.title : `Attempt ${lesson.id}`, text, endpoint);
        const source = sources.at(-1)!;
        for (const [key, value] of fields) if (key !== 'percentage') citations.push(CitationSchema.parse({ sourceItemId: source.id,
          quote: redactor.text(`${key}: ${value}`), locator: `${endpoint}#/lesson/${key}` }));
      }
      // Weight, exam/final/hurdle classification and owner grade shape remain unverified.
      gap(endpoint, 'UNSUPPORTED');
      try {
        const quiz = normalizeEdQuestions({ target: { course, lesson: lesson.id }, lesson: { lesson: { id: lesson.id, slides: lesson.slides.map(s => ({ id: s.id })) } },
          slides: lesson.slides.map(s => {
            const raw = bodies.get(`/api/lessons/slides/${s.id}`)?.slide as Record<string, unknown> | undefined;
            if (!raw) return undefined;
            return { slide: { id: raw.id, questions: (raw.questions as Record<string, unknown>[]).map(q => ({ id: q.id, type: q.type,
              ...(['text', 'multiple-choice'].includes(q.type as string) ? { prompt: redactor.text(q.prompt) } : {}),
              ...(q.type === 'multiple-choice' ? { options: z.array(z.object({ id, text: z.unknown() })).parse(q.options).map(o => ({ id: o.id, text: redactor.text(o.text) })) } : {}) })) } };
          }) });
        for (const s of quiz.sources) add(course, s.sourceItemId, 'assignment', s.locator, s.text, endpoint, s.sourceItemId);
        if (!quiz.coverage.complete) gap(endpoint, 'UNSUPPORTED');
      } catch { gap(endpoint, 'SOURCE_UNAVAILABLE'); }
    }
  }
  return { sources: redactNormalizedSources('ed', sources, [...bodies.values()], options.rules), citations, assessments: [], gaps, status: gaps.length && outcome.status === 'completed' ? 'partial' : outcome.status };
}
