import { expect, it } from 'vitest';
import { mergeCourses, normalizeCourseCode, type ProviderCourse } from '../../src/sync/merge.js';
const course = (provider: 'canvas' | 'ed', externalId: string, rawCode: string, term = '2026:S2'): ProviderCourse => ({ provider, externalId, rawCode, name: 'Same display name', term });
it('5.2 merges only a single normalized code in the same term, ignoring names', () => {
  const result = mergeCourses([course('canvas', '1', 'ABCD10001_2026_SM2'), { ...course('ed', '9', 'ABCD10001'), name: 'Different' }]);
  expect(result.courses).toHaveLength(1);
  expect(result.courses[0].sources).toHaveLength(2);
  expect(result.ambiguities).toEqual([]);
  expect(mergeCourses([course('canvas', '1', 'ABCD10001'), course('ed', '9', 'EFGH20002')]).courses).toHaveLength(2);
  expect(mergeCourses([course('canvas', '1', 'ABCD10001'), course('ed', '9', 'ABCD10001', '2025:S2')]).courses).toHaveLength(2);
});
it('5.2 leaves absent, multiple and provider-duplicate codes separate and reports them', () => {
  expect(normalizeCourseCode('ABCD10001 EFGH20002')).toBeUndefined();
  const result = mergeCourses([course('canvas', '1', 'ABCD10001'), course('ed', '9', 'ABCD10001'), course('ed', '10', 'ABCD10001'), course('ed', '11', 'Missing')]);
  expect(result.courses).toHaveLength(4);
  expect(result.courses.every(c => c.sources?.length === 1)).toBe(true);
  expect(result.ambiguities).toHaveLength(4);
});
