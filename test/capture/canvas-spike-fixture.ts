import { vi } from 'vitest';
import { CANVAS_ORIGIN } from '../../src/capture/discovery.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import type { CaptureSelection } from '../../src/capture/selection-store.js';
import type { CanvasSpikePage } from '../../src/capture/canvas-spike.js';

export const selectedCanvas: CaptureSelection = { version: 1, courses: [
  { source: 'canvas', origin: CANVAS_ORIGIN, id: '101', term: { label: 'Synthetic term' } },
] };
export function syntheticResponse(options: {
  status?: number; body?: unknown; contentType?: string; link?: string; type?: string;
  redirected?: boolean; jsonError?: boolean;
} = {}) {
  const status = options.status ?? 200;
  return { status, ok: status >= 200 && status < 300, type: options.type ?? 'basic',
    redirected: options.redirected ?? false, url: `${CANVAS_ORIGIN}/api/v1/courses/101/assignments`,
    headers: new Headers({ 'content-type': options.contentType ?? 'application/json; charset=utf-8', ...(options.link ? { link: options.link } : {}) }),
    json: async () => { if (options.jsonError) throw new Error('synthetic-private'); return options.body ?? [{ id: 1 }]; },
  };
}
export function canvasSpikeFixture(options: {
  url?: string; pageLocation?: string; response?: ReturnType<typeof syntheticResponse>; bodies?: unknown[];
} = {}) {
  let now = 0; let index = 0;
  const starts: number[] = []; const crossed: unknown[] = [];
  const limiter = new RequestLimiter({ now: () => now, sleep: async ms => { now += ms; } });
  const bodies = options.bodies ?? [
    [{ id: 1, name: 'synthetic-private', due_at: null, points_possible: 10, cookie: 'synthetic-private' }],
    [{ id: 2, group_weight: 20, authorization: 'synthetic-private' }],
    [{ id: 1, submission: { score: 8, grade: 'owner@example.invalid', workflow_state: 'graded', token: 'synthetic-private' } }],
    [{ id: 3, name: 'synthetic-private', items_count: 1 }],
    [{ id: 4, display_name: 'synthetic-private', url: 'https://evil.invalid/?token=synthetic-private', size: 10, 'content-type': 'application/pdf' }],
  ];
  const fetch = vi.fn(async (_endpoint: string, _options: RequestInit) => {
    starts.push(now);
    return options.response ?? syntheticResponse({ body: bodies[index++] });
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('location', new URL(options.pageLocation ?? options.url ?? `${CANVAS_ORIGIN}/courses/101`));
  const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
    const result = await Function(`return ${expression}`)(); crossed.push(result); return result;
  });
  const page: CanvasSpikePage = { url: () => options.url ?? `${CANVAS_ORIGIN}/courses/101`,
    evaluate: async <T>(expression: string): Promise<T> => await evaluate(expression) as T,
  };
  return { page, evaluate, limiter, fetch, starts, crossed };
}
