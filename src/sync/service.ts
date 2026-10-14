import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqliteRepository } from '../store/sqlite.js';
import { RequestLimiter, type RequestClock, type CaptureLimiter } from '../capture/limiter.js';
import { CourseworkError } from '../protocol/errors.js';
import { SyncRunSchema, CourseSchema, AssessmentSchema, SourceItemSchema, type Run, type SourceItem, type Assessment, type AssessmentLink, type Course, type Citation } from '../domain/schemas.js';
import { CanvasCourseSchema, CanvasAssignmentSchema, CanvasGroupSchema, CanvasModuleSchema, CanvasSubmissionSchema, discoverCanvas, readCanvasCollection, providerId, type JsonReader, type JsonResponse } from './canvas-reader.js';
import { mergeCourses, normalizeCourseCode, type ProviderCourse } from './merge.js';
import { readEdScope } from './ed-reader.js';
import { EdAttemptSchema, normalizeCanvas, normalizeEdAttempt, source } from './normalize.js';
import { CANVAS_ORIGIN, ED_ORIGIN } from './ed-scope.js';
import { scopeHash, sourceIdentity } from './ed-adapter.js';
import { createRedactor } from './redaction.js';
import type { Collection, QueryInput, QueryItem } from '../store/queries.js';

type Provider = 'canvas' | 'ed';
export type SyncOutcome = 'OK' | 'PARTIAL' | 'AUTH_EXPIRED' | 'LIMIT_EXCEEDED';
export interface ProviderOutcome { status: SyncOutcome; requests: number; pages: number; failures: number }
export interface SyncResult { run: Run; providers: Record<Provider, ProviderOutcome>; ambiguities: string[]; differences: { entityId: string; field: string }[]; citations: Citation[]; details?: { citations: number; ambiguities: number; differences: number } }
export interface SyncOptions {
  store: SqliteRepository; clock?: RequestClock; rules?: unknown;
  /** Readers and navigations must use this run's single limiter; injected tests do no network I/O. */
  readers(limiter: CaptureLimiter): Promise<{ canvas: JsonReader; ed: JsonReader }>;
  lock?: () => (() => void);
}
interface Stage { course: Course; provider: Provider; sources: SourceItem[]; assessments: Assessment[]; links: AssessmentLink[]; citations: Citation[]; complete: boolean }
const edDiscovery = z.array(z.object({ course: z.object({ id: providerId, code: z.string(), name: z.string(), status: z.string(),
  year: z.number().int(), session: z.string() }).passthrough() }).passthrough()).max(300);
const row = z.object({ id: providerId }).passthrough();
const edLessons = z.object({ lessons: z.array(row.extend({ kind: z.string(), title: z.string() })).max(300) }).passthrough();
const edDetail = z.object({ lesson: EdAttemptSchema.extend({ slides: z.array(row).max(300) }) }).passthrough();
const EdQuestionSchema = z.object({ id: providerId, type: z.string(), prompt: z.string().optional(), options: z.array(z.object({ id: providerId, text: z.string() })).max(300).optional() });
const edSlide = z.object({ slide: row.extend({ questions: z.array(EdQuestionSchema).max(300) }) }).passthrough();
const edThreads = z.object({ threads: z.array(row.extend({ title: z.string(), content: z.string() })).max(30) }).passthrough();
const edResources = z.object({ resources: z.array(row.extend({ title: z.string(), url: z.url().optional() })).max(300) }).passthrough();
const realClock: RequestClock = { now: Date.now, sleep: async ms => { await new Promise(resolve => setTimeout(resolve, ms)); } };
/** Each complete course is one atomic batch; failed providers never replace their previous data. */
export class SyncService {
  private running = false;
  private readonly store: SqliteRepository;
  private readonly clock: RequestClock;
  constructor(private readonly options: SyncOptions) { this.store = options.store; this.clock = options.clock ?? realClock; }
  private all<K extends Collection>(collection: K, filters: Omit<QueryInput<K>, 'limit' | 'cursor'> = {} as Omit<QueryInput<K>, 'limit' | 'cursor'>): QueryItem<K>[] {
    const items: QueryItem<K>[] = []; let cursor: string | undefined;
    do {
      const page = this.store.query(collection, { ...filters, limit: 500, cursor } as QueryInput<K>);
      items.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
  status() {
    const runs = this.all('runs', { command: 'sync' }).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const providerState = (provider: Provider) => {
      const measured = runs.flatMap(run => {
        const coverage = run.coverage?.filter(c => c.provider === provider);
        if (!coverage?.length) return [];
        const codes = coverage.flatMap(c => c.codes);
        const status: SyncOutcome = codes.includes('AUTH_EXPIRED') ? 'AUTH_EXPIRED' : codes.includes('LIMIT_EXCEEDED') ? 'LIMIT_EXCEEDED' : codes.length ? 'PARTIAL' : 'OK';
        return [{ id: run.id, at: run.endedAt, status, requests: coverage.reduce((n, c) => n + c.attempted, 0),
          pages: coverage.reduce((n, c) => n + c.completed, 0), failures: coverage.reduce((n, c) => n + c.failed, 0) }];
      });
      return { lastRun: measured[0], lastSuccess: measured.find(r => r.status === 'OK') };
    };
    return { running: this.running, canvas: providerState('canvas'), ed: providerState('ed') };
  }
  async run(input: { course?: string }): Promise<SyncResult> {
    if (input.course !== undefined && !/^[A-Z]{4}\d{5}$/.test(input.course)) throw new CourseworkError('INVALID_INPUT', 'Use a normalized course code.');
    if (this.running) throw new CourseworkError('LOCKED', 'A sync is already running.');
    const release = this.options.lock?.(); this.running = true;
    const startedAt = new Date(this.clock.now()).toISOString(); const limiter = new RequestLimiter(this.clock);
    const providers: Record<Provider, ProviderOutcome> = { canvas: { status: 'OK', requests: 0, pages: 0, failures: 0 }, ed: { status: 'OK', requests: 0, pages: 0, failures: 0 } };
    const coverage: NonNullable<Run['coverage']> = []; const raw: unknown[] = []; const stages: Stage[] = [];
    const differences: SyncResult['differences'] = []; const citations: Citation[] = []; let ambiguities: string[] = [];
    const mark = (provider: Provider, code: 'AUTH_EXPIRED' | 'LIMIT_EXCEEDED' | 'SOURCE_UNAVAILABLE' | 'INCOMPLETE', c?: NonNullable<Run['coverage']>[number]) => {
      if (providers[provider].status === 'OK' || code === 'AUTH_EXPIRED' || code === 'LIMIT_EXCEEDED') providers[provider].status = code === 'AUTH_EXPIRED' || code === 'LIMIT_EXCEEDED' ? code : 'PARTIAL';
      if (c && !c.codes.includes(code)) c.codes.push(code);
    };
    const collection = (provider: Provider, endpoint: string): NonNullable<Run['coverage']>[number] => {
      const base = { scopeRef: scopeHash(`${provider}:${endpoint}`), planned: 1, attempted: 0, completed: 0, skipped: 0, failed: 0, notStarted: 0, codes: [] };
      if (provider === 'canvas') return { ...base, provider, collection: endpoint.includes('/submissions/') ? 'submissions' : endpoint.includes('/assignment_groups?') ? 'assignment_groups' : endpoint.includes('/modules?') ? 'modules' : 'assignments' };
      return { ...base, provider, collection: endpoint === '/api/user' ? 'courses' : endpoint.includes('/slides/') ? 'slides' : endpoint.startsWith('/api/lessons/') ? 'attempts' : endpoint.includes('/threads?') ? 'threads' : endpoint.endsWith('/resources') ? 'resources' : 'lessons' };
    };
    const makeRun = (error = false) => SyncRunSchema.parse({ id: runId, command: 'sync', startedAt, endedAt: new Date(this.clock.now()).toISOString(),
      steps: limiter.attempts, requests: limiter.attempts, pages: providers.canvas.pages + providers.ed.pages,
      failures: providers.canvas.failures + providers.ed.failures, coverage, outcome: error || Object.values(providers).some(p => p.status !== 'OK') ? 'error' : 'ok' });
    const runId = randomUUID();
    try {
      const ports = await this.options.readers(limiter);
      const read = async (provider: Provider, endpoint: string, schema?: z.ZodType): Promise<JsonResponse> => {
        const c = collection(provider, endpoint); coverage.push(c);
        if (['AUTH_EXPIRED', 'LIMIT_EXCEEDED'].includes(providers[provider].status)) {
          c.notStarted = 1; c.codes.push(providers[provider].status as 'AUTH_EXPIRED' | 'LIMIT_EXCEEDED');
          return { kind: 'gap', reason: 'unavailable' };
        }
        const before = limiter.attempts;
        let response: JsonResponse;
        try { response = await ports[provider].read(endpoint); }
        catch (error) {
          if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') {
            c.notStarted = 1; mark(provider, 'LIMIT_EXCEEDED', c); return { kind: 'gap', reason: 'unavailable' };
          }
          response = { kind: 'gap', reason: 'unavailable' };
        }
        c.attempted = limiter.attempts - before; providers[provider].requests += c.attempted;
        if (response.kind === 'json') {
          raw.push(response.body);
          if (schema) {
            const parsed = schema.safeParse(response.body);
            if (!parsed.success) response = { kind: 'gap', reason: 'invalidJson' };
            else response = { ...response, body: parsed.data };
          }
        }
        if (response.kind === 'auth') { c.failed++; providers[provider].failures++; mark(provider, 'AUTH_EXPIRED', c); }
        else if (response.kind === 'gap') {
          if (response.status === 404 || response.status === 405) { c.skipped++; c.codes.push('SKIPPED'); mark(provider, 'INCOMPLETE', c); }
          else { c.failed++; providers[provider].failures++; mark(provider, 'SOURCE_UNAVAILABLE', c); }
        } else { c.completed++; providers[provider].pages++; }
        return response;
      };
      const canvasReader: JsonReader = { read: p => read('canvas', p, z.array(CanvasCourseSchema).max(100)) };
      const canvas = await discoverCanvas(canvasReader, startedAt);
      if (!canvas.complete && providers.canvas.status === 'OK') { mark('canvas', 'INCOMPLETE', coverage.find(c => c.provider === 'canvas')); }
      const discovery = await read('ed', '/api/user', edDiscovery);
      const ed: ProviderCourse[] = [];
      if (discovery.kind === 'json') {
        const dateParts = new Intl.DateTimeFormat('en', { timeZone: 'Australia/Melbourne', year: 'numeric', month: 'numeric' }).formatToParts(new Date(startedAt));
        const year = Number(dateParts.find(p => p.type === 'year')!.value); const semester = Number(dateParts.find(p => p.type === 'month')!.value) >= 7 ? 'S2' : 'S1';
        for (const { course } of edDiscovery.parse(discovery.body)) {
          const session = /^(?:S|SM|Semester\s*)([12])$/i.exec(course.session)?.[1];
          if (!session) { mark('ed', 'INCOMPLETE', coverage.find(c => c.provider === 'ed')); continue; }
          if (course.status !== 'active' || course.year !== year || `S${session}` !== semester) continue;
          ed.push({ provider: 'ed', externalId: course.id, rawCode: course.code, name: course.name, term: `${course.year}:S${session}` });
        }
      }
      const discovered = [...canvas.courses, ...ed];
      const merged = mergeCourses(discovered, this.all('courses')); ambiguities = merged.ambiguities;
      const scoped = merged.courses.filter(c => !input.course || c.code === input.course);
      for (const course of scoped) {
        for (const origin of course.sources ?? []) {
          if (origin.platform === 'canvas') {
            const prefix = `/api/v1/courses/${origin.externalId}`;
            const assignments = await readCanvasCollection({ read: p => read('canvas', p, z.array(CanvasAssignmentSchema).max(100)) }, `${prefix}/assignments?per_page=100&page=1`, CanvasAssignmentSchema);
            const groups = await readCanvasCollection({ read: p => read('canvas', p, z.array(CanvasGroupSchema).max(100)) }, `${prefix}/assignment_groups?per_page=100&page=1`, CanvasGroupSchema);
            const modules = await readCanvasCollection({ read: p => read('canvas', p, z.array(CanvasModuleSchema).max(100)) }, `${prefix}/modules?per_page=100&page=1`, CanvasModuleSchema);
            const submissions: z.output<typeof CanvasSubmissionSchema>[] = []; let complete = assignments.complete && groups.complete && modules.complete;
            for (const assignment of assignments.rows) {
              const response = await read('canvas', `${prefix}/assignments/${assignment.id}/submissions/self`, CanvasSubmissionSchema.refine(s => s.assignment_id === assignment.id));
              if (response.kind === 'json') submissions.push(CanvasSubmissionSchema.parse(response.body)); else complete = false;
            }
            const result = normalizeCanvas(course, { assignments: assignments.rows, groups: groups.rows, modules: modules.rows, submissions }, startedAt, this.all('assessments', { courseId: course.id }));
            if (!complete && providers.canvas.status === 'OK') mark('canvas', 'INCOMPLETE', coverage.find(c => c.provider === 'canvas'));
            stages.push({ course, provider: 'canvas', ...result, complete });
          } else {
            const captured = new Map<string, Record<string, unknown>>();
            const owned = new Map<string, string>();
            const reader = { read: async (endpoint: string): Promise<JsonResponse> => {
              const schema = endpoint.endsWith('/lessons') ? edLessons : endpoint.includes('/slides/') ? edSlide : endpoint.startsWith('/api/lessons/') ? edDetail : endpoint.includes('/threads?') ? edThreads : edResources;
              const response = await read('ed', endpoint, schema);
              if (response.kind !== 'json') return response;
              const body = response.body as Record<string, unknown>;
              const detail = (body.lesson ?? body.slide) as { id: string; slides?: { id: string }[] } | undefined;
              const list = (body.lessons ?? body.threads ?? body.resources) as { id: string; kind?: string }[] | undefined;
              if (detail && (detail.id !== endpoint.split('/').at(-1) || !owned.has(endpoint)) || list && new Set(list.map(r => r.id)).size !== list.length) {
                const c = coverage.at(-1)!; c.completed--; providers.ed.pages--; c.failed++; providers.ed.failures++; mark('ed', 'SOURCE_UNAVAILABLE', c);
                return { kind: 'gap', reason: 'invalidJson' };
              }
              for (const lesson of (body.lessons ?? []) as { id: string; kind: string }[]) if (lesson.kind === 'attempt') owned.set(`/api/lessons/${lesson.id}`, origin.externalId);
              for (const slide of detail?.slides ?? []) owned.set(`/api/lessons/slides/${slide.id}`, origin.externalId);
              captured.set(endpoint, body); return response;
            } };
            const result = await readEdScope({ courses: [{ source: 'ed', origin: ED_ORIGIN, id: origin.externalId, term: { label: course.term, year: Number(course.term.split(':')[0]), session: course.term.split(':')[1] } }], transport: reader, snapshot: async () => {}, discoveryCaptured: true });
            const sources: SourceItem[] = [];
            for (const [endpoint, body] of captured) {
              if (body.lesson) sources.push(normalizeEdAttempt(course.id, origin.externalId, body.lesson, startedAt));
              for (const row of (body.threads ?? body.resources ?? []) as { id: string; title: string; content?: string; url?: string }[]) {
                sources.push(source('ed', origin.externalId, course.id, `${body.threads ? 'thread' : 'resource'}:${row.id}`, body.threads ? 'post' : 'material', row.title,
                  `title: ${row.title}${row.content ? `\ncontent: ${row.content}` : ''}${row.url ? `\nurl: ${row.url}` : ''}`, startedAt, `${ED_ORIGIN}${endpoint}`));
              }
              if (body.slide) {
                const slide = body.slide as { id: string; questions: unknown[] };
                // Only published question fields, never solutions, answers or people, enter the store.
                const questions = z.array(EdQuestionSchema).parse(slide.questions);
                sources.push(source('ed', origin.externalId, course.id, `slide:${slide.id}`, 'material', `Slide ${slide.id}`, JSON.stringify(questions), startedAt, `${ED_ORIGIN}${endpoint}`));
              }
            }
            stages.push({ course, provider: 'ed', sources, assessments: [], links: [], citations: [], complete: result.status === 'completed' });
          }
        }
      }
      const redactor = createRedactor(raw, this.options.rules);
      // Link precedence belongs to the item, including links to assessments in another course.
      const existingLinks = this.all('assessments').flatMap(a => this.store.readAssessmentLinks(a.id));
      const existingSources = this.all('sourceItems');
      for (const incomingCourse of scoped) {
        const previous = this.store.loadCourse(incomingCourse.id);
        const activeSources = incomingCourse.sources?.filter(s => providers[s.platform].status !== 'AUTH_EXPIRED');
        const preservedSources = previous?.sources?.filter(s => !activeSources?.some(i => i.platform === s.platform && i.externalId === s.externalId)
          && (providers[s.platform].status === 'AUTH_EXPIRED' || !merged.courses.some(c => c.term === incomingCourse.term && c.sources?.some(i => i.platform === s.platform && i.externalId === s.externalId)))) ?? [];
        let course = CourseSchema.parse({ ...incomingCourse, name: redactor.text(incomingCourse.name),
          sources: [...activeSources ?? [], ...preservedSources],
          ...(previous ? { assessmentsComplete: previous.assessmentsComplete } : {}) });
        for (const a of this.store.readAnnotations('course', course.id).sort((a, b) => (a.origin === 'owner' ? 1 : 0) - (b.origin === 'owner' ? 1 : 0) || Date.parse(a.at) - Date.parse(b.at))) {
          course = CourseSchema.parse({ ...course, [a.field]: a.value });
        }
        const sourceItems: SourceItem[] = []; const assessments: Assessment[] = []; const assessmentLinks: AssessmentLink[] = [];
        for (const stage of stages.filter(s => s.course.id === course.id)) {
          if (providers[stage.provider].status === 'AUTH_EXPIRED') continue;
          citations.push(...stage.citations.map(c => ({ ...c, quote: redactor.text(c.quote) })));
          for (const s of stage.sources) {
            const safeText = (value: string) => {
              try { return redactor.readText(value); } catch {
                stage.complete = false; mark(stage.provider, 'INCOMPLETE', coverage.find(c => c.provider === stage.provider));
                return '[withheld]';
              }
            };
            const title = safeText(s.title); const text = safeText(s.text);
            sourceItems.push(SourceItemSchema.parse({ ...s, title, text, url: s.url ? redactor.url(s.url) : undefined, contentHash: scopeHash(JSON.stringify([title, text, s.facts ?? null])) }));
          }
          for (const old of existingSources.filter(s => s.platform === stage.provider && stage.course.sources?.some(origin =>
            origin.platform === s.platform && sourceIdentity(s.platform, s.platform === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN, origin.externalId, s.externalId) === s.id))) {
            // The bounded first thread page is not a complete thread collection.
            if (!stage.sources.some(s => s.id === old.id)) sourceItems.push({ ...old, courseId: course.id,
              removed: stage.complete && old.kind !== 'post' ? true : old.removed });
          }
          for (const fresh of stage.assessments) {
            const old = this.store.loadAssessment(fresh.id);
            const annotations = this.store.readAnnotations('assessment', fresh.id).sort((a, b) => (a.origin === 'owner' ? 1 : 0) - (b.origin === 'owner' ? 1 : 0) || Date.parse(a.at) - Date.parse(b.at));
            const effective: Record<string, unknown> = { ...fresh, name: redactor.text(fresh.name) };
            if (old && old.origin !== 'sync') continue;
            for (const a of annotations) {
              if ((Object.hasOwn(fresh, a.field) || a.field === 'weight') && JSON.stringify(effective[a.field]) !== JSON.stringify(a.value)) differences.push({ entityId: fresh.id, field: a.field });
              effective[a.field] = a.value;
            }
            assessments.push(AssessmentSchema.parse(effective));
          }
          for (const link of stage.links) {
            const history = existingLinks.filter(l => l.sourceItemId === link.sourceItemId);
            const latest = history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
            if (latest && (latest.origin !== 'sync' || latest.assessmentId === link.assessmentId)) continue;
            assessmentLinks.push(link);
          }
        }
        if (sourceItems.length || assessments.length || !previous && activeSources?.length) {
          this.store.saveBatch({ modules: [{ id: 'school', name: 'Coursework', glyph: 'book', auto: true }], courses: [course], sourceItems, assessments, assessmentLinks });
        }
      }
      const run = makeRun(); this.store.recordRun(run);
      return summarize({ run, providers, ambiguities, differences, citations });
    } catch (error) {
      if (error instanceof CourseworkError && error.code === 'AUTH_EXPIRED') for (const provider of ['canvas', 'ed'] as const) {
        const c = collection(provider, provider === 'ed' ? '/api/user' : '/api/v1/courses'); c.notStarted = 1; coverage.push(c); mark(provider, 'AUTH_EXPIRED', c);
      }
      else for (const provider of ['canvas', 'ed'] as const) mark(provider, 'SOURCE_UNAVAILABLE', coverage.find(c => c.provider === provider));
      const run = makeRun(true); this.store.recordRun(run);
      if (error instanceof CourseworkError && error.code === 'AUTH_EXPIRED') return summarize({ run, providers, ambiguities, differences, citations });
      throw new CourseworkError('SOURCE_UNAVAILABLE', 'Sync could not safely persist course data.');
    } finally { this.running = false; release?.(); }
  }
}

/** The complete ledger/provenance remains in SQLite; responses must retain provider outcomes within 64 KiB. */
function summarize(result: SyncResult): SyncResult {
  const coverage: NonNullable<Run['coverage']> = [];
  for (const row of result.run.coverage ?? []) {
    let aggregate = coverage.find(c => c.provider === row.provider && c.collection === row.collection);
    if (!aggregate) {
      aggregate = { ...row, scopeRef: scopeHash(`${row.provider}:${row.collection}`), codes: [...row.codes] };
      coverage.push(aggregate); continue;
    }
    for (const field of ['planned', 'attempted', 'completed', 'skipped', 'failed', 'notStarted'] as const) aggregate[field] += row[field];
    aggregate.codes = [...new Set([...aggregate.codes, ...row.codes])];
  }
  return { ...result, run: { ...result.run, coverage }, citations: result.citations.slice(0, 40), ambiguities: result.ambiguities.slice(0, 40), differences: result.differences.slice(0, 40),
    details: { citations: result.citations.length, ambiguities: result.ambiguities.length, differences: result.differences.length } };
}
