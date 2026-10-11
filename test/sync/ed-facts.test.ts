import { expect, it } from 'vitest';
import { syncEd, sourceIdentity } from '../../src/sync/ed-adapter.js';
import { selected } from '../quiz/synthetic.js';
import { fixture, reader, time } from './synthetic.js';
it('4.2 retains effective due, explicit status and grade provenance without guessed assessments', async () => {
  const bodies = fixture();
  bodies['/api/lessons/11'] = { lesson: { id: 11, title: 'Synthetic quiz', slides: [{ id: 21 }],
    due_at: '2026-10-14T00:00:00Z', effective_due_at: '2026-10-15T10:00:00+10:00',
    submitted: true, status: 'graded', score: 3, max_score: 4 } };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  const evidence = result.sources.find(s => s.externalId === 'attempt:11')!;
  expect(evidence.text).toContain('effective_due_at: 2026-10-15T00:00:00.000Z');
  expect(evidence.text).toContain('submitted: true');
  expect(evidence.text).toContain('status: graded');
  expect(evidence.text).toContain('score: 3'); expect(evidence.text).toContain('max_score: 4');
  expect(evidence.text).toContain('percentage: 75');
  expect(result.assessments).toEqual([]);
  for (const citation of result.citations) expect(result.sources.find(s => s.id === citation.sourceItemId)?.text).toContain(citation.quote);
  expect(result.citations.some(c => c.locator === '/api/lessons/11#/lesson/effective_due_at')).toBe(true);
});
it.each([0, -1, Infinity])('4.2 invalid denominator %s never invents percentages', async max_score => {
  const bodies = fixture(); bodies['/api/lessons/11'] = { lesson: { id: 11, title: 'Synthetic', slides: [{ id: 21 }], score: 3, max_score } };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  expect(result.sources.find(s => s.externalId === 'attempt:11')?.text).not.toContain('percentage:');
  expect(result.gaps.some(g => g.code === 'UNSUPPORTED')).toBe(true);
});
it('4.2 stable identities distinguish provider and origin, and fetch time does not affect hashes', async () => {
  const a = await syncEd({ selection: selected, transport: reader(), fetchedAt: time });
  const b = await syncEd({ selection: selected, transport: reader(), fetchedAt: '2026-10-13T00:00:00Z' });
  expect(a.sources.map(s => [s.id, s.contentHash])).toEqual(b.sources.map(s => [s.id, s.contentHash]));
  expect(sourceIdentity('canvas', 'https://canvas.lms.unimelb.edu.au', '7', 'course')).not.toBe(sourceIdentity('ed', 'https://edstem.org', '7', 'course'));
  expect(sourceIdentity('canvas', 'https://a.invalid', '7', 'course')).not.toBe(sourceIdentity('canvas', 'https://b.invalid', '7', 'course'));
});
it('4.2 present null effective due never falls back and absent status never implies not started', async () => {
  const bodies = fixture(); bodies['/api/lessons/11'] = { lesson: { id: 11, title: 'Synthetic', slides: [{ id: 21 }], effective_due_at: null, due_at: '2026-10-14T00:00:00Z' } };
  const result = await syncEd({ selection: selected, transport: reader(bodies), fetchedAt: time });
  const text = result.sources.find(s => s.externalId === 'attempt:11')!.text;
  expect(text).toContain('effective_due_at: null'); expect(text).not.toContain('status:');
  expect(result.assessments).toEqual([]);
});
