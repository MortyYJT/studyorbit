import { expect, it } from 'vitest';
import { diffEntity } from '../../src/sync/diff.js';
import { synthetic, syntheticAssessment } from '../fixtures/synthetic.js';
const at = '2026-01-01T00:00:00Z';
const a = syntheticAssessment('a', 20, 70);
it('6.1 emits created/deleted with complete snapshots and one update for simultaneous changes', () => {
  expect(diffEntity('assessment', undefined, a, at)?.kind).toBe('created');
  expect(diffEntity('assessment', a, undefined, at)).toMatchObject({ kind: 'deleted', before: a });
  const b = { ...a, due: at, score: 90, name: 'Changed' };
  expect(diffEntity('assessment', a, b, at)).toMatchObject({ kind: 'updated', before: a, after: { name: 'Changed', due: '2026-01-01T00:00:00.000Z', score: 90 } });
});
it('6.1 removes optional owned fields but preserves fields outside adapter ownership', () => {
  const old = { ...a, due: at };
  const { score: _score, ...next } = a;
  const change = diffEntity('assessment', old, next, at, ['score', 'due']);
  expect(change?.after).toEqual({ ...next });
  expect(diffEntity('assessment', a, { ...a, name: 'Ignored' }, at, ['score'])).toBeUndefined();
});
it('6.1 ignores fetch time, key ordering, equivalent dates/numbers and compares fields beyond hashes', () => {
  const source = { ...synthetic.sourceItem, platform: 'ed' as const };
  expect(diffEntity('source_item', source, { ...source, fetchedAt: '2026-02-01T00:00:00Z' }, at)).toBeUndefined();
  expect(diffEntity('assessment', { ...a, due: at }, { ...a, due: '2026-01-01T11:00:00+11:00', weight: 20.0 }, at)).toBeUndefined();
  expect(diffEntity('assessment', a, Object.fromEntries(Object.entries(a).reverse()) as typeof a, at)).toBeUndefined();
  expect(diffEntity('source_item', source, { ...source, text: 'Changed with same hash' }, at)?.kind).toBe('updated');
});
it('6.1 refuses mismatched identities and invalid snapshots', () => {
  expect(() => diffEntity('assessment', a, { ...a, id: 'other' }, at)).toThrow();
  expect(() => diffEntity('assessment', a, { ...a, weight: -1 }, at)).toThrow();
});
it('6.1 ignores fresh owner-field values while preserving stored owner fields', () => {
  const old = synthetic.course;
  const next = { ...old, name: 'New title', moduleId: 'different-module', assessmentsComplete: false };
  expect(diffEntity('course', old, next, at)?.after).toMatchObject({ name: 'New title', moduleId: old.moduleId, assessmentsComplete: true });
});
