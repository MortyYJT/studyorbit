import { expect, it } from 'vitest';
import { canDeleteScope } from '../../src/sync/reconciliation.js';
const complete = { selected: true, enumerationComplete: true, normalizationComplete: true, codes: [] };
it('6.2 permits deletion only with fresh selected complete authoritative coverage', () => {
  expect(canDeleteScope('assignments', complete)).toBe(true);
  for (const field of ['selected', 'enumerationComplete', 'normalizationComplete']) {
    expect(canDeleteScope('assignments', { ...complete, [field]: false })).toBe(false);
  }
});
it.each(['AUTH_EXPIRED', 'LIMIT_EXCEEDED', 'CANCELED', 'INCOMPLETE', 'SKIPPED', 'NOT_STARTED', 'SOURCE_UNAVAILABLE', 'UNSUPPORTED'] as const)(
  '6.2 preserves missing rows for %s', code => {
    expect(canDeleteScope('assignments', { ...complete, codes: [code] })).toBe(false);
  });
it('6.2 first-page threads never prove absence and PDFs require validated complete replacement', () => {
  expect(canDeleteScope('threads', complete)).toBe(false);
  expect(canDeleteScope('materials', { ...complete, normalizationComplete: false })).toBe(false);
  expect(canDeleteScope('materials', complete)).toBe(true);
});
