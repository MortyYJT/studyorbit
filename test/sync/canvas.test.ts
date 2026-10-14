import { afterEach, expect, it, vi } from 'vitest';
import { CanvasTransport, safeCanvasEndpoint } from '../../src/capture/canvas-transport.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import { readCanvasCollection, CanvasAssignmentSchema, discoverCanvas } from '../../src/sync/canvas-reader.js';
import { canvasCourses, clock, json } from './delivery-fixture.js';
afterEach(() => vi.unstubAllGlobals());
it('5.1 selects active current-term enrollments and validates synthetic JSON', async () => {
  const read = vi.fn(async () => json(canvasCourses()));
  const result = await discoverCanvas({ read }, '2026-10-15T00:00:00Z');
  expect(result.courses.map(c => c.externalId)).toEqual(['1']);
  expect(read).toHaveBeenCalledWith('/api/v1/courses?enrollment_type=student&enrollment_state=active&include[]=term&per_page=100&page=1');
  expect((await discoverCanvas({ read: async () => json([{ id: 'broken' }]) }, '2026-10-15T00:00:00Z')).complete).toBe(false);
});
it('5.1 follows bounded collection pages, rejects loops and cross-origin next links', async () => {
  const endpoint = '/api/v1/courses/1/assignments?per_page=100&page=1';
  const read = vi.fn(async (p: string) => json([{ id: p.endsWith('1') ? 7 : 8, name: 'Synthetic', assignment_group_id: 3 }], p.endsWith('1') ? endpoint.replace(/page=1$/, 'page=2') : undefined));
  expect((await readCanvasCollection({ read }, endpoint, CanvasAssignmentSchema)).rows).toHaveLength(2);
  for (const next of [endpoint, 'https://evil.invalid/api/v1/courses/1/assignments?per_page=100&page=2']) {
    expect((await readCanvasCollection({ read: async () => json([], next) }, endpoint, CanvasAssignmentSchema)).complete).toBe(false);
  }
  const capped = vi.fn(async (p: string) => json([], p.replace(/page=\d+$/, `page=${Number(p.split('page=').at(-1)) + 1}`)));
  expect((await readCanvasCollection({ read: capped }, endpoint, CanvasAssignmentSchema)).complete).toBe(false);
  expect(capped).toHaveBeenCalledTimes(20);
});
it('5.1 uses cookie-only GETs, self submissions and refuses other students before fetching', async () => {
  vi.stubGlobal('location', { origin: 'https://canvas.lms.unimelb.edu.au' });
  const fetch = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ score: 8 }) }));
  vi.stubGlobal('fetch', fetch);
  const page = { url: () => 'https://canvas.lms.unimelb.edu.au/', evaluate: async <T>(script: string) => await (0, eval)(script) as T };
  const transport = new CanvasTransport(page, new RequestLimiter(clock()));
  expect(await transport.read('/api/v1/courses/1/assignments/7/submissions/self')).toMatchObject({ kind: 'json' });
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/courses/1/assignments/7/submissions/self', { method: 'GET', credentials: 'same-origin', redirect: 'manual', signal: expect.any(AbortSignal) }]);
  for (const path of ['/api/v1/courses/1/students/submissions', '/api/v1/courses/1/assignments/7/submissions/99', '/api/v1/courses/1/assignments/7/submissions/self?student_ids[]=all']) {
    expect(safeCanvasEndpoint(path)).toBe(false);
    expect(await transport.read(path)).toMatchObject({ kind: 'gap' });
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('5.1 bootstraps a new resident tab with budgeted navigation and refuses sign-in redirects', async () => {
  let url = 'about:blank'; let routeHandler: ((route: any) => Promise<void>) | undefined;
  const limiter = new RequestLimiter(clock());
  const page = { url: () => url, route: vi.fn(async (_pattern, handler) => { routeHandler = handler; }), unroute: vi.fn(async () => {}),
    goto: vi.fn(async (target: string) => {
      const route = { request: () => ({ isNavigationRequest: () => true, url: () => target, frame: () => ({ parentFrame: () => null }) }),
        fetch: async () => ({ status: () => 200, headers: () => ({}), dispose: async () => {} }), fulfill: async () => { url = target; }, abort: async () => {} };
      await routeHandler!(route);
    }), evaluate: async <T>() => json([]) as T };
  expect(await new CanvasTransport(page, limiter).read('/api/v1/courses/1/modules?per_page=100&page=1')).toMatchObject({ kind: 'json' });
  expect(limiter.attempts).toBe(2);
  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(page.unroute).toHaveBeenCalledTimes(1);
});
