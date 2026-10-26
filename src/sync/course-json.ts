import { z } from 'zod';
import { AiPolicySchema, CourseTermSchema } from '../domain/schemas.js';

/**
 * The course document contract (#169, #170): one zod schema for the built document and the store import,
 * plus the format, sanity and completeness checks and the third-submission degrade. Browser-safe (no Node imports).
 */
export const CANVAS_ORIGIN = 'https://canvas.lms.unimelb.edu.au';
export const ED_ORIGIN = 'https://edstem.org';
export const HANDBOOK_ORIGIN = 'https://handbook.unimelb.edu.au';
export const MAX_SUBMISSIONS = 3;

export const TermSchema = CourseTermSchema;
export const CourseCodeSchema = z.string().regex(/^[A-Z]{4}\d{5}$/);
export const PolicyValueSchema = AiPolicySchema;
export const PlatformSchema = z.enum(['canvas', 'ed']);
export const PlatformReadSchema = z.enum(['read', 'blocked', 'absent']);
const KindSchema = z.preprocess(value => value === 'ongoing' ? 'participation' : value,
  z.enum(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded']));
const StatusSchema = z.enum(['not_started', 'in_progress', 'submitted', 'graded']);
const TimeSchema = z.iso.datetime({ offset: true });
const PercentSchema = z.number().min(0).max(100);
const PointsSchema = z.number().min(0).max(100000);
const NameSchema = z.string().trim().min(1).max(300);

const onOrigin = (origin: string) => z.url().max(2048).refine(value => {
  try { return new URL(value).origin === origin; } catch { return false; }
}, `Must be a URL on ${origin}`);
export const CanvasUrlSchema = onOrigin(CANVAS_ORIGIN);
export const EdUrlSchema = onOrigin(ED_ORIGIN);
/** A page URL on either platform, for quotes' sources and item links. */
export const PageUrlSchema = z.url().max(2048).refine(value => {
  try { return [CANVAS_ORIGIN, ED_ORIGIN].includes(new URL(value).origin); } catch { return false; }
}, 'Must be a Canvas or Ed URL');
export const PagesSchema = z.object({ canvas: CanvasUrlSchema.optional(), ed: EdUrlSchema.optional() });

export const FieldStateSchema = z.enum(['found', 'unknown', 'not_applicable', 'derived']);
export const ViaSchema = z.enum(['ax', 'screenshot', 'api', 'handbook']);
/**
 * Every page fact is a wrapper; `quoted` facts (due, weight, hurdle, AI policy) carry a quote and its URL
 * when read from a page, or just the API URL when read from an API. A Handbook source is accepted only
 * with `via: "handbook"`; every other via uses a Canvas or Ed URL.
 */
function field<T extends z.ZodType>(value: T, quoted = false) {
  return z.object({ value: value.nullable(), state: FieldStateSchema, via: ViaSchema.optional(), checkedAt: TimeSchema.optional(),
    quote: z.string().trim().min(1).max(500).optional(), source: z.url().max(2048).optional() }).superRefine((input, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const value = (input as { value?: unknown }).value;
    if ((input.state === 'found' || input.state === 'derived') && value === null) issue('value', 'a found value is required');
    if ((input.state === 'unknown' || input.state === 'not_applicable') && value !== null) issue('value', 'must be null unless found');
    if (input.state === 'found' && input.via === undefined) issue('via', 'say how it was read (ax, screenshot, api or handbook)');
    if (input.state === 'unknown' && input.checkedAt === undefined) issue('checkedAt', 'unknown fields need the check time');
    if (quoted && input.state === 'found') {
      if (input.source === undefined) issue('source', 'give the URL of the value');
      if (input.via !== 'api' && input.quote === undefined) issue('quote', 'quote the page text');
    }
    if (input.source !== undefined) {
      let origin: string | undefined;
      try { origin = new URL(input.source).origin; } catch { origin = undefined; }
      const allowed = input.via === 'handbook' ? [HANDBOOK_ORIGIN] : [CANVAS_ORIGIN, ED_ORIGIN];
      if (origin === undefined || !allowed.includes(origin)) issue('source', input.via === 'handbook'
        ? `Must be a URL on ${HANDBOOK_ORIGIN}` : 'Must be a Canvas or Ed URL');
    }
  });
}
export type Field<T> = { value: T | null; state: z.infer<typeof FieldStateSchema>; via?: 'ax' | 'screenshot' | 'api' | 'handbook'; checkedAt?: string; quote?: string; source?: string };

const courseFields = {
  code: field(CourseCodeSchema), name: field(NameSchema), term: field(TermSchema), aiPolicy: field(PolicyValueSchema, true),
};
export const CourseLevelSchema = z.object({ ...courseFields, pages: PagesSchema,
  platforms: z.object({ canvas: PlatformReadSchema, ed: PlatformReadSchema }), componentsComplete: z.boolean() });
const itemFields = { name: field(NameSchema), kind: field(KindSchema).optional(), unlockAt: field(TimeSchema).optional(),
  due: field(TimeSchema, true), status: field(StatusSchema), score: field(PointsSchema), outOf: field(PointsSchema),
  weight: field(PercentSchema, true), aiPolicy: field(PolicyValueSchema, true).optional() };
export const ItemSchema = z.object({ key: z.string().regex(/^[A-Z]{4}\d{5}:(?:canvas|ed):[A-Za-z0-9._:-]{1,160}$/),
  url: PageUrlSchema.optional(), ...itemFields });
const componentFields = { name: field(NameSchema), kind: field(KindSchema), count: field(z.number().int().min(0).max(300)),
  weight: field(PercentSchema, true), isFinal: field(z.boolean()), hurdleMin: field(PercentSchema, true) };
export const ComponentFieldsSchema = z.object({ key: z.string().regex(/^[A-Z]{4}\d{5}:[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120), ...componentFields });
export const ComponentSchema = ComponentFieldsSchema.extend({ items: z.array(ItemSchema).max(300) });
/** The contract: course level, grading components, items. */
export const CourseDocumentSchema = z.object({ course: CourseLevelSchema, components: z.array(ComponentSchema).max(100) });
export type CourseDocument = z.output<typeof CourseDocumentSchema>;
export type CourseComponent = CourseDocument['components'][number];
export type CourseItem = CourseComponent['items'][number];

export function courseKey(code: string, term: string): string { return `${code}:${term}`; }
/** One normalized University code in the text (for example "ABCD10001_2026_SM2"), else undefined. */
export function normalizeCourseCode(value: string): string | undefined {
  const matches = [...value.toUpperCase().matchAll(/(?<![A-Z0-9])[A-Z]{4}\d{5}(?!\d)/g)];
  return matches.length === 1 ? matches[0]![0] : undefined;
}

export interface DocumentIssue { path: string; reason: string }
export interface DocumentWarning { code: 'WEIGHT_SUM'; sum: number }
export interface CheckedDocument {
  key?: string; code?: string; term?: string;
  /** Every failing path; the agent re-reads these (screenshot for empty fields). */
  errors: DocumentIssue[];
  /** No valid course code and term: refused on every submission. */
  fatal: boolean;
  /** The storable document; on a final submission failing fields are already unknown and invalid entries left out. */
  document?: CourseDocument;
  unknown: string[]; dropped: string[]; warnings: DocumentWarning[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const unknownField = (checkedAt: string): Field<never> => ({ value: null, state: 'unknown', checkedAt });
const join = (prefix: string, path: readonly PropertyKey[]) => path.reduce<string>((text, part) =>
  typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${String(part)}` : String(part), prefix);
const known = <T>(input: Field<T>): input is Field<T> & { value: T } => (input.state === 'found' || input.state === 'derived') && input.value !== null;
const melbourneYear = (instant: string) => Number(new Intl.DateTimeFormat('en', { timeZone: 'Australia/Melbourne', year: 'numeric' }).format(new Date(instant)));

/**
 * Parse one level, turning failing wrapper fields into unknown so the rest stays checkable; returns undefined
 * when a non-wrapper part (a key, the shape itself) cannot be repaired.
 */
function parseLevel<S extends z.ZodType>(schema: S, raw: unknown, prefix: string, wrappers: readonly string[], now: string,
  issues: DocumentIssue[], repair: (name: string, rest: readonly PropertyKey[], value: Json) => boolean = () => false): z.output<S> | undefined {
  if (!isObject(raw)) { issues.push({ path: prefix, reason: 'must be an object' }); return undefined; }
  const value: Json = { ...raw };
  for (let round = 0; round < 4; round++) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) {
      const [head, ...rest] = issue.path;
      const missing = issue.code === 'invalid_type' && rest.length === 0 && value[String(head)] === undefined;
      issues.push({ path: join(prefix, issue.path), reason: missing ? 'missing' : issue.message.slice(0, 160) });
      if (typeof head === 'string' && wrappers.includes(head)) value[head] = unknownField(now);
      else if (typeof head !== 'string' || !repair(head, rest, value)) return undefined;
    }
  }
  return undefined;
}

/**
 * Check a submitted document. Not final: every failing path is an error and nothing is stored. Final (third
 * submission): failing fields become unknown, invalid items/components are left out, a nameless course keeps
 * its code and several finals lose `isFinal`; only a missing code or term stays fatal.
 */
export function validateCourseDocument(input: unknown, options: { final: boolean; now: string }): CheckedDocument {
  const { now, final } = options;
  const issues: DocumentIssue[] = []; const unknown: string[] = []; const dropped: string[] = []; const warnings: DocumentWarning[] = [];
  const fatalResult = (): CheckedDocument => ({ errors: dedupe(issues), fatal: true, unknown, dropped, warnings });
  if (!isObject(input)) { issues.push({ path: '', reason: 'must be an object with course and components' }); return fatalResult(); }
  const course = parseLevel(CourseLevelSchema, input.course, 'course', Object.keys(courseFields), now, issues, (name, rest, value) => {
    if (name === 'pages') {
      const pages = isObject(value.pages) && typeof rest[0] === 'string' ? { ...value.pages } : {};
      if (typeof rest[0] === 'string') delete pages[rest[0]];
      value.pages = pages; return true;
    }
    if (name === 'platforms') { const platforms = isObject(value.platforms) ? { ...value.platforms } : {};
      for (const platform of ['canvas', 'ed']) if (!PlatformReadSchema.safeParse(platforms[platform]).success) platforms[platform] = 'absent';
      value.platforms = platforms; return true; }
    if (name === 'componentsComplete') { value.componentsComplete = false; return true; }
    return false;
  });
  if (!course) return fatalResult();
  const code = known(course.code) ? course.code.value : undefined;
  const term = known(course.term) ? course.term.value : undefined;
  const year = term ? Number(term.slice(0, 4)) : undefined;
  // Indices stay those of the submission, so reported paths point at what the agent sent.
  const components: { index: number; value: CourseComponent; items: { index: number; value: CourseItem }[] }[] = [];
  const rawComponents = Array.isArray(input.components) ? input.components : [];
  if (!Array.isArray(input.components)) issues.push({ path: 'components', reason: 'must be an array' });
  if (rawComponents.length > 100) issues.push({ path: 'components', reason: 'at most 100 components' });
  rawComponents.slice(0, 100).forEach((raw, index) => {
    const prefix = `components[${index}]`;
    const fields = parseLevel(ComponentFieldsSchema, isObject(raw) ? { ...raw, items: undefined } : raw, prefix, Object.keys(componentFields), now, issues);
    if (!fields) { dropped.push(prefix); return; }
    const rawItems = isObject(raw) && Array.isArray(raw.items) ? raw.items : [];
    if (!isObject(raw) || !Array.isArray(raw.items)) issues.push({ path: `${prefix}.items`, reason: 'must be an array' });
    if (rawItems.length > 300) issues.push({ path: `${prefix}.items`, reason: 'at most 300 items' });
    const items = rawItems.slice(0, 300).flatMap((rawItem, itemIndex) => {
      const value = parseLevel(ItemSchema, rawItem, `${prefix}.items[${itemIndex}]`, Object.keys(itemFields), now, issues, (name, _rest, target) => {
        if (name === 'url') { delete target.url; return true; }
        return false;
      });
      if (!value) { dropped.push(`${prefix}.items[${itemIndex}]`); return []; }
      return [{ index: itemIndex, value }];
    });
    components.push({ index, value: { ...fields, items: items.map(entry => entry.value) }, items });
  });

  // Sanity and completeness, collected with the paths a final submission degrades.
  type Action = 'unknown' | 'drop' | 'fatal';
  const failures: { path: string; reason: string; action: Action; apply: () => void }[] = [];
  const fail = (path: string, reason: string, action: Action, apply: () => void = () => {}) => failures.push({ path, reason, action, apply });
  const need = <T>(path: string, target: Field<T>, action: Action, set: (value: Field<never>) => void) => {
    if (!known(target)) fail(path, 'required: read it again, using a screenshot if the page text lacks it', action, () => set(target.state === 'unknown' ? target as Field<never> : unknownField(now)));
  };
  need('course.code', course.code, 'fatal', () => {});
  need('course.term', course.term, 'fatal', () => {});
  need('course.name', course.name, 'unknown', value => { course.name = value; });
  const seenComponents = new Set<string>(); const seenItems = new Set<string>();
  const finals = components.filter(entry => entry.value.isFinal.value === true && known(entry.value.isFinal));
  for (const entry of components) {
    const prefix = `components[${entry.index}]`; const value = entry.value;
    if (code && !value.key.startsWith(`${code}:`)) fail(`${prefix}.key`, 'must start with the course code', 'drop');
    if (seenComponents.has(value.key)) fail(`${prefix}.key`, 'duplicate component key', 'drop');
    seenComponents.add(value.key);
    need(`${prefix}.name`, value.name, 'drop', () => {});
    need(`${prefix}.kind`, value.kind, 'unknown', next => { value.kind = next; });
    if (finals.length > 1 && finals.includes(entry)) fail(`${prefix}.isFinal`, 'only one component can be the final', 'unknown', () => { value.isFinal = unknownField(now); });
    const stated = entry.items.reduce((sum, item) => sum + (known(item.value.weight) && item.value.weight.state === 'found' ? item.value.weight.value : 0), 0);
    if (known(value.weight) && stated > value.weight.value + 1e-9) fail(`${prefix}.weight`, 'is below the stated item weights', 'unknown', () => { value.weight = unknownField(now); });
    for (const item of entry.items) {
      const itemPrefix = `${prefix}.items[${item.index}]`; const target = item.value;
      if (code && !target.key.startsWith(`${code}:`)) fail(`${itemPrefix}.key`, 'must start with the course code', 'drop');
      if (seenItems.has(target.key)) fail(`${itemPrefix}.key`, 'duplicate item key', 'drop');
      seenItems.add(target.key);
      need(`${itemPrefix}.name`, target.name, 'drop', () => {});
      need(`${itemPrefix}.status`, target.status, 'drop', () => {});
      if (value.kind.value !== 'exam') need(`${itemPrefix}.due`, target.due, 'unknown', next => { target.due = next; });
      if (year !== undefined && known(target.due) && melbourneYear(target.due.value) !== year) {
        fail(`${itemPrefix}.due`, `must fall in ${year} (the term's year, Melbourne time)`, 'unknown', () => { target.due = unknownField(now); });
      }
      if (known(target.score) && known(target.outOf) && target.score.value > target.outOf.value) {
        fail(`${itemPrefix}.score`, 'is above outOf', 'unknown', () => { target.score = unknownField(now); });
      }
    }
  }
  const errors = dedupe([...issues, ...failures.map(({ path, reason }) => ({ path, reason }))]);
  const result = (document?: CourseDocument): CheckedDocument => ({ ...(code && term ? { key: courseKey(code, term), code, term } : {}),
    errors, fatal: !code || !term, ...(document ? { document } : {}), unknown: [...new Set(unknown)], dropped: [...new Set(dropped)], warnings });
  if (!code || !term) return result();
  if (final) {
    // Format issues on wrapper fields were already made unknown above; record them with the degraded checks.
    for (const issue of issues) {
      const match = /^(course\.(?:code|name|term|aiPolicy)|components\[\d+\]\.(?:name|kind|count|weight|isFinal|hurdleMin)|components\[\d+\]\.items\[\d+\]\.(?:name|kind|unlockAt|due|status|score|outOf|weight|aiPolicy))(?:\.|$)/.exec(issue.path);
      if (match && !dropped.some(path => match[1]!.startsWith(`${path}.`))) unknown.push(match[1]!);
    }
    for (const failure of failures) {
      if (failure.action === 'drop') dropped.push(failure.path.replace(/\.(?:key|name|status)$/, ''));
      else { failure.apply(); unknown.push(failure.path); }
    }
  }
  const isDropped = (path: string) => dropped.includes(path);
  const kept = components.filter(entry => !isDropped(`components[${entry.index}]`)).map(entry => ({ ...entry.value,
    items: entry.items.filter(item => !isDropped(`components[${entry.index}].items[${item.index}]`)).map(item => item.value) }));
  const weights = kept.map(entry => entry.weight);
  if (weights.length && weights.every(known)) {
    const sum = weights.reduce((total, weight) => total + (weight.value as number), 0);
    if (Math.abs(sum - 100) > 1e-6) warnings.push({ code: 'WEIGHT_SUM', sum: Math.round(sum * 1000) / 1000 });
  }
  const document: CourseDocument = { course, components: kept };
  return result(final || errors.length === 0 ? document : undefined);
}

function dedupe(issues: DocumentIssue[]): DocumentIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => { const key = `${issue.path}\u0000${issue.reason}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
