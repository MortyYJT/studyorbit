import { CourseworkError } from '../protocol/errors.js';
import type { SelectedCourse } from './discovery.js';
import type { EdResponse, EdSnapshot } from './ed-transport.js';
/** Snapshot callbacks must settle inside the reader's shared limiter attempt, before read resolves. */
export interface EdReader { read(endpoint: string, options?: { snapshot?: EdSnapshot }): Promise<EdResponse> }
export interface EdOutcome {
  source: 'ed'; status: 'completed' | 'partial' | 'authExpired' | 'capReached' | 'aborted' | 'notStarted';
  attempted: number; saved: number; failed: number; skipped: number;
  gaps: { endpoint: string; status?: number; reason: string }[];
  error?: { code: 'AUTH_EXPIRED'; next: string };
}
function id(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}
function rows(body: unknown, key: string): unknown[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : undefined;
}
export async function runEdCapture(options: {
  courses: SelectedCourse[]; transport: EdReader; snapshot: EdSnapshot; discoveryCaptured?: boolean;
}): Promise<EdOutcome> {
  const outcome: EdOutcome = { source: 'ed', status: 'completed', attempted: 0, saved: 0, failed: 0, skipped: 0, gaps: [] };
  const selected = options.courses.filter(course => course.source === 'ed');
  if (!selected.length) return outcome;
  const seen = new Set<string>();
  const read = async (endpoint: string): Promise<unknown> => {
    if (seen.has(endpoint)) return undefined;
    if (['authExpired', 'capReached', 'aborted'].includes(outcome.status)) return undefined;
    seen.add(endpoint);
    let response: EdResponse;
    try { response = await options.transport.read(endpoint, { snapshot: options.snapshot }); outcome.attempted++; }
    catch (error) {
      if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') outcome.status = 'capReached';
      else if (error instanceof Error && error.name === 'AbortError') outcome.status = 'aborted';
      else { outcome.attempted++; outcome.failed++; outcome.status = 'partial'; outcome.gaps.push({ endpoint, reason: 'unavailable' }); }
      return undefined;
    }
    if (response.kind === 'auth') {
      outcome.status = 'authExpired'; outcome.error = { code: 'AUTH_EXPIRED', next: 'Ask the user to sign in to Ed again.' };
      outcome.gaps.push({ endpoint, ...(response.status === undefined ? {} : { status: response.status }), reason: 'auth' });
      return undefined;
    }
    if (response.kind === 'json') { outcome.saved++; return response.body; }
    if (response.kind === 'gap' && (response.status === 404 || response.status === 405)) outcome.skipped++;
    else outcome.failed++;
    outcome.status = 'partial';
    outcome.gaps.push({ endpoint, ...(response.status === undefined ? {} : { status: response.status }), reason: response.kind === 'gap' ? response.reason : 'auth' });
    return undefined;
  };
  if (!options.discoveryCaptured) await read('/api/user');
  for (const course of selected) {
    const body = await read(`/api/courses/${course.id}/lessons`);
    if (body !== undefined && !rows(body, 'lessons')) {
      outcome.status = 'partial'; outcome.gaps.push({ endpoint: `/api/courses/${course.id}/lessons`, reason: 'invalidShape' });
    }
    for (const entry of rows(body, 'lessons') ?? []) {
      if (!entry || typeof entry !== 'object') continue;
      const lesson = entry as Record<string, unknown>;
      const lessonId = id(lesson.id);
      if (lesson.kind !== 'attempt' || !lessonId) continue;
      const detail = await read(`/api/lessons/${lessonId}`);
      const nested = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).lesson : undefined;
      for (const slide of rows(nested, 'slides') ?? rows(detail, 'slides') ?? []) {
        const slideId = slide && typeof slide === 'object' ? id((slide as Record<string, unknown>).id) : undefined;
        if (slideId) await read(`/api/lessons/slides/${slideId}`);
      }
    }
    await read(`/api/courses/${course.id}/threads?limit=30&sort=new`);
    await read(`/api/courses/${course.id}/resources`);
  }
  return outcome;
}
