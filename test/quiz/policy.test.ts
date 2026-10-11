import { expect, it } from 'vitest';
import { validatePolicy, validateGrant, authorize, verifyRealPrerequisites } from '../../src/quiz/policy.js';
const policy = { version: 1, course: '7', status: 'owner-attested', attestation: 'Synthetic owner statement', date: '2026-10-12', cap: 3 };
const binding = { assessmentId: 'synthetic-assessment', course: '7', lesson: '11', category: 'assignment' };
const grant = { version: 1, binding, level: 3, date: '2026-10-12' };
it('validates explicit allowed/prohibited and dated owner-attested policies', () => {
  expect(validatePolicy(policy)).toEqual(policy);
  expect(validatePolicy({ version: 1, course: '7', status: 'allowed', quote: 'Synthetic permission', locator: 'policy:1', cap: 3 })).toMatchObject({ status: 'allowed' });
  expect(() => validatePolicy({ ...policy, date: '2026-02-30' })).toThrow();
  expect(() => validatePolicy({ ...policy, attestation: '' })).toThrow();
  expect(() => validatePolicy({ version: 1, course: '7', status: 'allowed', cap: 3 })).toThrow();
  expect(() => validatePolicy({ version: 1, course: '7', status: 'prohibited', quote: 'Synthetic prohibition', locator: 'policy:1', cap: 2 })).toThrow();
});
it('requires an exact per-assessment grant within course cap', () => {
  expect(authorize(policy, grant, binding, 2)).toMatchObject({ level: 3 });
  for (const [p, g, b] of [[undefined, grant, binding], [policy, undefined, binding], [{ ...policy, cap: 2 }, grant, binding],
    [policy, grant, { ...binding, assessmentId: 'another' }], [policy, grant, { ...binding, course: '8' }],
    [policy, { ...grant, level: 1 }, binding], [{ version: 1, course: '7', status: 'prohibited', quote: 'No', locator: 'p', cap: 1 }, grant, binding]]) {
    expect(() => authorize(p, g, b, 2)).toThrow(/policy|grant|authorization/i);
  }
  expect(() => validateGrant({ ...grant, level: 5 })).toThrow();
});
it.each(['exam', 'unknown'])('denies %s classification above L1', category => {
  expect(() => authorize(policy, { ...grant, binding: { ...binding, category } }, { ...binding, category }, 2)).toThrow();
});
it('real Q1 needs dated actual-course attestation and explicit private-repository verification', () => {
  const prerequisite = { version: 1, binding, repositoryPrivate: true, verifiedAt: '2026-10-12T00:00:00Z' };
  expect(() => verifyRealPrerequisites({ course: '7', lesson: '11' }, policy, prerequisite)).not.toThrow();
  for (const [p, r, t] of [[undefined, prerequisite, { course: '7', lesson: '11' }], [policy, undefined, { course: '7', lesson: '11' }],
    [policy, { ...prerequisite, repositoryPrivate: false }, { course: '7', lesson: '11' }], [policy, prerequisite, { course: '8', lesson: '11' }],
    [{ ...policy, date: '2026-10-13' }, prerequisite, { course: '7', lesson: '11' }]]) {
    expect(() => verifyRealPrerequisites(t, p, r)).toThrow();
  }
});
it('broader L4 policy/grant can authorize an L2/L3 Q1 operation without enabling Q1 submission', () => {
  expect(authorize({ ...policy, cap: 4 }, { ...grant, level: 4 }, binding, 3)).toMatchObject({ level: 4 });
});
