import { expect, it, vi } from 'vitest';
import { syncEd } from '../../src/sync/ed-adapter.js';
import { createRedactor } from '../../src/sync/redaction.js';
import { selected } from './ed-scope-fixture.js';
import { fixture, reader, time } from './synthetic.js';
it('4.5 label-based six digit identifiers, invisible characters and nested URL encoding cannot escape', () => {
  const redactor = createRedactor([{ author: 'Synthetic Person-Z' }]);
  expect(redactor.text('student ID: 123456')).not.toContain('123456');
  expect(() => redactor.text('Synthetic\u200b Person-Z')).toThrowError();
  expect(redactor.text('url: https://edstem.org/Synthetic%2520Person-Z')).not.toContain('Person-Z');
});
it('4.5 conflicting slide ownership cannot publish another selected courses questions', async () => {
  const selection = { version: 1, courses: [...selected.courses, { ...selected.courses[0], id: '8' }] };
  const bodies = fixture();
  bodies['/api/courses/8/lessons'] = { lessons: [{ id: 13, kind: 'attempt' }] };
  bodies['/api/lessons/13'] = { lesson: { id: 13, title: 'Synthetic other quiz', slides: [{ id: 21 }] } };
  bodies['/api/courses/8/threads?limit=30&sort=new'] = { threads: [] };
  bodies['/api/courses/8/resources'] = { resources: [] };
  const result = await syncEd({ selection, transport: reader(bodies), fetchedAt: time });
  expect(result.sources.some(s => s.id === 'ed:8:13:21:31')).toBe(false);
  expect(result.gaps.some(g => g.code === 'SOURCE_UNAVAILABLE')).toBe(true);
});
it('4.5 stop errors stay content free and do not retry', async () => {
  const { CourseworkError } = await import('../../src/protocol/errors.js');
  for (const error of [new CourseworkError('LIMIT_EXCEEDED', 'private-sentinel'), new DOMException('private-sentinel', 'AbortError')]) {
    const transport = { read: vi.fn(async () => { throw error; }) };
    const result = await syncEd({ selection: selected, transport, fetchedAt: time });
    expect(result.status).toBe(error instanceof CourseworkError ? 'capReached' : 'aborted');
    expect(transport.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private-sentinel');
  }
});
