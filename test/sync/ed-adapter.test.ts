import { expect, it, vi } from 'vitest';
import { syncEd } from '../../src/sync/ed-adapter.js';
import { EdTransport } from '../../src/capture/ed-transport.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import type { DiscoveryPage } from '../../src/capture/discovery-adapters.js';
import type { EdReader } from '../../src/capture/ed-capture.js';
import { selected } from '../quiz/synthetic.js';
import { fixture, reader, time } from './synthetic.js';
it('4.1 consumes bounded selected Ed reads, source ids and Q1 question refs', async () => {
  const transport = reader(); const snapshot = vi.fn(async () => {});
  const result = await syncEd({ selection: selected, transport, snapshot, fetchedAt: time });
  expect(vi.mocked(transport.read).mock.calls.map(c => c[0])).toEqual(Object.keys(fixture()));
  expect(snapshot).toHaveBeenCalledTimes(6);
  expect(result.sources.some(s => s.id === 'ed:7:11:21:31')).toBe(true);
  expect(result.sources.some(s => s.externalId === 'thread:41')).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/offset=30|lessons\/12|authToken/);
  expect(result.gaps.some(g => g.code === 'INCOMPLETE')).toBe(true);
});
it('4.1 withholds unknown shapes and mismatched detail ids without following their slides', async () => {
  const bodies = fixture(); bodies['/api/lessons/11'] = { lesson: { id: 99, slides: [{ id: 999 }] } };
  bodies['/api/courses/7/resources'] = { unexpected: 'private sentinel' };
  const transport = reader(bodies);
  const result = await syncEd({ selection: selected, transport, fetchedAt: time });
  expect(vi.mocked(transport.read).mock.calls.map(c => c[0])).not.toContain('/api/lessons/slides/999');
  expect(JSON.stringify(result)).not.toContain('private sentinel');
  expect(result.gaps.some(g => g.code === 'SOURCE_UNAVAILABLE')).toBe(true);
});
it('4.1 empty selection does not read; invalid origin fails before reads', async () => {
  const transport = reader();
  await syncEd({ selection: { version: 1, courses: [] }, transport, fetchedAt: time });
  expect(transport.read).not.toHaveBeenCalled();
  await expect(syncEd({ selection: { version: 1, courses: [{ ...selected.courses[0], origin: 'https://evil.invalid' }] }, transport, fetchedAt: time })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(transport.read).not.toHaveBeenCalled();
});
it('4.1 isolates auth and no-view refusal with no retries or fallback', async () => {
  const transport = reader();
  vi.mocked(transport.read).mockImplementation(async endpoint => endpoint.includes('/slides/')
    ? { kind: 'gap', status: 405, reason: 'http' } : endpoint.includes('/threads')
      ? { kind: 'auth', code: 'AUTH_EXPIRED' } : { kind: 'json', status: 200, body: fixture()[endpoint] });
  const result = await syncEd({ selection: selected, transport, fetchedAt: time });
  expect(result.status).toBe('authExpired');
  expect(vi.mocked(transport.read).mock.calls).toHaveLength(5);
  expect(JSON.stringify(vi.mocked(transport.read).mock.calls)).not.toContain('view=');
  expect(result.gaps.some(g => g.code === 'AUTH_EXPIRED')).toBe(true);
});
it('4.1 consumes the actual merged transport and courses-only discovery response', async () => {
  const page = { url: () => 'https://edstem.org/au/', evaluate: vi.fn(async (script: string) => {
    const endpoint = Object.keys(fixture()).find(p => script.includes(JSON.stringify(p)))!;
    return { kind: 'json', status: 200, body: fixture()[endpoint] };
  }) } as unknown as DiscoveryPage;
  let clock = 0;
  const transport = new EdTransport(page, new RequestLimiter({ now: () => clock, sleep: async ms => { clock += ms; } }));
  const result = await syncEd({ selection: selected, transport, fetchedAt: time });
  expect(result.sources.length).toBeGreaterThan(0);
});
