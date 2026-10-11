import type { CaptureLimiter } from './limiter.js';
import { CANVAS_ORIGIN } from './discovery.js';
import { validateSelection } from './selection-store.js';
import { CourseworkError } from '../protocol/errors.js';

export interface CanvasSpikePage {
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
}
type FieldType = 'missing' | 'null' | 'array' | 'object' | 'number' | 'string' | 'boolean';
export type CanvasSpikeCollection = {
  collection: string; kind: 'json' | 'auth' | 'gap'; status?: number;
  coverage: 'first_page_only' | 'failed'; rows?: number;
  fields?: Record<string, FieldType[]>; pagination?: 'more' | 'none' | 'unknown';
  reason?: 'unavailable' | 'http' | 'nonJson' | 'invalidJson' | 'invalidShape';
};
export interface CanvasSpikeResult {
  collections: CanvasSpikeCollection[];
  code?: 'AUTH_EXPIRED' | 'SOURCE_UNAVAILABLE'; next?: string;
}
type Probe = { collection: string; path: string; fields: Record<string, FieldType[]>; owner?: boolean };
const id: FieldType[] = ['number', 'string'];
const text: FieldType[] = ['string', 'null'];
const numeric: FieldType[] = ['number', 'null'];
const probes: Probe[] = [
  { collection: 'assignments', path: 'assignments?per_page=100', fields: {
    id, name: text, due_at: text, points_possible: numeric, assignment_group_id: id,
  } },
  { collection: 'assignment_groups', path: 'assignment_groups?per_page=100', fields: { id, group_weight: numeric, rules: ['object', 'null'] } },
  // Candidate student-only shape. Live permission/field proof belongs to task 1.2.
  { collection: 'owner_submissions', path: 'assignments?include%5B%5D=submission&per_page=100', owner: true, fields: {
    id, submission: ['object', 'null'], 'submission.score': numeric,
    'submission.grade': text, 'submission.workflow_state': text, 'submission.submitted_at': text,
  } },
  { collection: 'modules', path: 'modules?per_page=100', fields: { id, name: text, items_count: numeric } },
  { collection: 'files', path: 'files?per_page=100', fields: { id, display_name: text, url: text, size: numeric, 'content-type': text } },
];

/** Self-contained browser function: only fixed field names/types cross the page boundary. */
async function inspectPage(input: { origin: string; endpoint: string; probe: Probe }): Promise<CanvasSpikeCollection> {
  const { probe } = input;
  const auth = (status?: number): CanvasSpikeCollection => ({ collection: probe.collection, kind: 'auth', coverage: 'failed', ...(status === undefined ? {} : { status }) });
  const gap = (reason: CanvasSpikeCollection['reason'], status?: number): CanvasSpikeCollection => ({
    collection: probe.collection, kind: 'gap', coverage: 'failed', reason, ...(status === undefined ? {} : { status }),
  });
  if (location.origin !== input.origin || /^\/login(?:\/|$)/.test(location.pathname)) return auth();
  try {
    const response = await fetch(input.endpoint, {
      method: 'GET', credentials: 'same-origin', redirect: 'manual', signal: AbortSignal.timeout(30000),
    });
    const status = response.status;
    if (response.type === 'opaqueredirect' || response.redirected || status === 401 || status === 403 || status >= 300 && status < 400) return auth(status);
    if (!response.ok) return gap('http', status);
    if (response.url) {
      const url = new URL(response.url);
      if (url.origin !== input.origin || /^\/login(?:\/|$)/.test(url.pathname)) return auth(status);
    }
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return gap('nonJson', status);
    let body: unknown;
    try { body = await response.json(); } catch { return gap('invalidJson', status); }
    if (!Array.isArray(body) || body.length > 100) return gap('invalidShape', status);
    const fields: Record<string, FieldType[]> = {};
    const typeOf = (value: unknown): FieldType => value === undefined ? 'missing' : value === null ? 'null'
      : Array.isArray(value) ? 'array' : typeof value as FieldType;
    for (const row of body) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return gap('invalidShape', status);
      if (!(typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0 || typeof row.id === 'string' && /^[1-9]\d*$/.test(row.id))) return gap('invalidShape', status);
      if (probe.owner && !Object.hasOwn(row, 'submission')) return gap('invalidShape', status);
      for (const [path, allowed] of Object.entries(probe.fields)) {
        let value: unknown = row;
        for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
        const type = typeOf(value);
        if (type !== 'missing' && (!allowed.includes(type) || type === 'number' && !Number.isFinite(value))) return gap('invalidShape', status);
        const observed = fields[path] ??= [];
        if (!observed.includes(type)) observed.push(type);
      }
    }
    for (const observed of Object.values(fields)) observed.sort();
    const link = response.headers.get('link');
    // Never export or follow Link URLs. Full safe pagination belongs to the production reader.
    const pagination = link === null ? 'none' : /;\s*rel\s*=\s*"?next\b/i.test(link) ? 'more' : 'unknown';
    return { collection: probe.collection, kind: 'json', status, rows: body.length, fields, pagination, coverage: 'first_page_only' };
  } catch { return gap('unavailable'); }
}

/** Five bounded first-page reads; no profile launch, raw export, retries or live-proof claim. */
export async function probeCanvasStudentSession(
  page: CanvasSpikePage, selection: unknown, courseId: string,
  limiter: CaptureLimiter, signal?: AbortSignal,
): Promise<CanvasSpikeResult> {
  const selected = validateSelection(selection);
  if (!/^[1-9]\d*$/.test(courseId) || !selected.courses.some(course => course.source === 'canvas' && course.origin === CANVAS_ORIGIN && course.id === courseId)) {
    throw new CourseworkError('INVALID_INPUT', 'Select a Canvas course before probing.');
  }
  const result: CanvasSpikeResult = { collections: [] };
  const expired = () => ({ ...result, code: 'AUTH_EXPIRED' as const, next: new CourseworkError('AUTH_EXPIRED', 'Canvas login required.').next });
  for (const probe of probes) {
    if (signal?.aborted) throw new DOMException('Capture cancelled.', 'AbortError');
    let url: URL;
    try { url = new URL(page.url()); } catch { return expired(); }
    if (url.origin !== CANVAS_ORIGIN || url.username || url.password || /^\/login(?:\/|$)/.test(url.pathname)) return expired();
    const evidence = await limiter.attempt(async (): Promise<CanvasSpikeCollection> => {
      try {
        return await page.evaluate<CanvasSpikeCollection>(`(${inspectPage.toString()})(${JSON.stringify({
          origin: CANVAS_ORIGIN, endpoint: `/api/v1/courses/${courseId}/${probe.path}`, probe,
        })})`);
      } catch { return { collection: probe.collection, kind: 'gap', coverage: 'failed', reason: 'unavailable' }; }
    }, signal);
    if (signal?.aborted) throw new DOMException('Capture cancelled.', 'AbortError');
    result.collections.push(evidence);
    if (evidence.kind === 'auth') return expired();
    if (evidence.kind === 'gap') return { ...result, code: 'SOURCE_UNAVAILABLE' };
  }
  return result;
}
