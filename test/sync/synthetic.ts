import { vi } from 'vitest';
import type { EdReader } from '../../src/sync/ed-reader.js';
export function fixture() {
  return {
    '/api/user': [{ course: { id: 7, status: 'active', year: 2026, session: 'S2', name: 'Synthetic', code: 'SYN' } }],
    '/api/courses/7/lessons': { lessons: [{ id: 11, kind: 'attempt', title: 'Synthetic quiz' }, { id: 12, kind: 'content', title: 'Synthetic lesson' }] },
    '/api/lessons/11': { lesson: { id: 11, title: 'Synthetic quiz', slides: [{ id: 21 }] } },
    '/api/lessons/slides/21': { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt: 'Synthetic prompt' }] } },
    '/api/courses/7/threads?limit=30&sort=new': { threads: [{ id: 41, title: 'Synthetic thread', content: 'Synthetic post' }], next: '/api/courses/7/threads?offset=30' },
    '/api/courses/7/resources': { resources: [{ id: 51, title: 'Synthetic resource', url: 'https://edstem.org/synthetic.pdf' }] },
  } as Record<string, unknown>;
}
export function reader(bodies = fixture()): EdReader {
  return { read: vi.fn<EdReader['read']>(async (endpoint, options) => {
    const body = bodies[endpoint];
    await options?.snapshot?.(endpoint, body, 200);
    return { kind: 'json', status: 200, body };
  }) };
}
export const time = '2026-10-12T00:00:00Z';
