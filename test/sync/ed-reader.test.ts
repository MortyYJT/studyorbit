import { expect, it, vi } from 'vitest';
import { readEdScope, type EdReader } from '../../src/sync/ed-reader.js';
import { ED_ORIGIN, CANVAS_ORIGIN } from '../../src/sync/ed-scope.js';
import type { EdSyncScope } from '../../src/sync/ed-scope.js';
import type { EdResponse } from '../../src/capture/ed-transport.js';
const courses: EdSyncScope['courses'][number][] = [
  { source: 'ed', origin: ED_ORIGIN, id: '101', term: { label: '2026 Synthetic', year: 2026, session: 'Synthetic' } },
  { source: 'canvas', origin: CANVAS_ORIGIN, id: '202', term: { label: 'Synthetic' } },
];
function reader(bodies: Record<string, unknown>): EdReader {
  return { read: vi.fn<EdReader['read']>(async (endpoint, options) => {
    const body = bodies[endpoint] ?? {};
    await options?.snapshot?.(endpoint, body, 200);
    return { kind: 'json', status: 200, body };
  }) };
}
it('expands selected attempts and referenced slides only, deduplicating source ids', async () => {
  const transport = reader({ '/api/courses/101/lessons': { lessons: [{ id: 11, kind: 'attempt' }, { id: 12, kind: 'content' }, { id: 11, kind: 'attempt' }] },
    '/api/lessons/11': { lesson: { slides: [{ id: 21 }, { id: 22 }, { id: 21 }] } } });
  const snapshot = vi.fn(async () => {});
  const result = await readEdScope({ courses, transport, snapshot, discoveryCaptured: true });
  expect(vi.mocked(transport.read).mock.calls.map(call => call[0]).slice(0, 4)).toEqual([
    '/api/courses/101/lessons', '/api/lessons/11', '/api/lessons/slides/21', '/api/lessons/slides/22',
  ]);
  expect(JSON.stringify(vi.mocked(transport.read).mock.calls)).not.toMatch(/courses\/202|lessons\/12|view/);
  expect(result.saved).toBeGreaterThanOrEqual(4);
});
it('does not manufacture ids from malformed lists or follow external links', async () => {
  const transport = reader({ '/api/courses/101/lessons': { lessons: [{ id: '../12', kind: 'attempt' }, { id: 11, kind: 'attempt' }] },
    '/api/lessons/11': { lesson: { slides: [{ id: 'https://evil.invalid' }] } } });
  await readEdScope({ courses, transport, snapshot: async () => {}, discoveryCaptured: true });
  expect(vi.mocked(transport.read).mock.calls.map(call => call[0]).filter(p => p.startsWith('/api/lessons/'))).toEqual(['/api/lessons/11']);
});
it('empty selected Ed courses schedules no Ed reads', async () => {
  const transport = reader({}); await readEdScope({ courses: courses.slice(1), transport, snapshot: async () => {} });
  expect(transport.read).not.toHaveBeenCalled();
});
it('reads only first thread page and resources after missing lessons', async () => {
  const transport: EdReader = { read: vi.fn<EdReader['read']>(async endpoint => endpoint.endsWith('/lessons')
    ? { kind: 'gap', status: 404, reason: 'http' } : { kind: 'json', status: 200, body: { next: '/api/courses/101/threads?offset=30', external: 'https://evil.invalid/file' } }) };
  const result = await readEdScope({ courses, transport, snapshot: async () => {}, discoveryCaptured: true });
  expect(vi.mocked(transport.read).mock.calls.map(call => call[0])).toEqual([
    '/api/courses/101/lessons', '/api/courses/101/threads?limit=30&sort=new', '/api/courses/101/resources',
  ]);
  expect(result).toMatchObject({ skipped: 1, failed: 0, saved: 2, status: 'partial', gaps: [{ endpoint: '/api/courses/101/lessons', status: 404 }] });
});
it.each([404, 405, 429, 500])('classifies HTTP %s without retries and preserves bounded diagnostics', async status => {
  const transport: EdReader = { read: vi.fn<EdReader['read']>(async () => ({ kind: 'gap', status, reason: 'http' })) };
  const result = await readEdScope({ courses, transport, snapshot: async () => {}, discoveryCaptured: true });
  expect(result).toMatchObject({ skipped: status === 404 || status === 405 ? 3 : 0, failed: status === 404 || status === 405 ? 0 : 3, status: 'partial' });
  expect(transport.read).toHaveBeenCalledTimes(3);
});
it('marks malformed lesson shapes as gaps rather than silently complete', async () => {
  const result = await readEdScope({ courses, transport: reader({ '/api/courses/101/lessons': { unrelated: [] } }), snapshot: async () => {}, discoveryCaptured: true });
  expect(result.status).toBe('partial'); expect(result.gaps).toContainEqual({ endpoint: '/api/courses/101/lessons', reason: 'invalidShape' });
});
it.each([401, 403])('stops only Ed on %s and retains previous successful snapshots', async status => {
  const saved: string[] = [];
  const transport: EdReader = { read: vi.fn<EdReader['read']>(async (endpoint, options) => {
    if (endpoint.includes('/threads')) return { kind: 'auth', code: 'AUTH_EXPIRED', status };
    const body = { lessons: [] }; await options?.snapshot?.(endpoint, body, 200);
    return { kind: 'json', status: 200, body };
  }) };
  const result = await readEdScope({ courses, transport, snapshot: async endpoint => { saved.push(endpoint); }, discoveryCaptured: true });
  expect(result).toMatchObject({ status: 'authExpired', saved: 1, error: { code: 'AUTH_EXPIRED', next: expect.stringMatching(/sign in/i) } });
  expect(saved).toEqual(['/api/courses/101/lessons']); expect(transport.read).toHaveBeenCalledTimes(2);
});
it('missing token stops discovery and remaining Ed queue', async () => {
  const transport: EdReader = { read: vi.fn<EdReader['read']>(async () => ({ kind: 'auth', code: 'AUTH_EXPIRED' })) };
  const result = await readEdScope({ courses, transport, snapshot: async () => {} });
  expect(result.status).toBe('authExpired'); expect(transport.read).toHaveBeenCalledTimes(1);
});
it.each(['capReached', 'aborted'])('keeps saved work when %s stops the queue', async status => {
  const transport: EdReader = { read: vi.fn<EdReader['read']>(async endpoint => {
    if (endpoint.endsWith('/lessons')) return { kind: 'json', status: 200, body: { lessons: [] } };
    if (status === 'aborted') throw new DOMException('stopped', 'AbortError');
    const { CourseworkError } = await import('../../src/protocol/errors.js');
    throw new CourseworkError('LIMIT_EXCEEDED', 'cap');
  }) };
  expect(await readEdScope({ courses, transport, snapshot: async () => {}, discoveryCaptured: true })).toMatchObject({ status, saved: 1 });
});
