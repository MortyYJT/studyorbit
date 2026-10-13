import { expect, it } from 'vitest';
import { auditSchema } from '../../src/protocol/legacy-audit.js';
const record = { version: 1, operation: 'grant', phase: 'outcome', at: '2026-01-01T00:00:00Z', runId: '11111111-1111-4111-8111-111111111111', code: 'OK', assessmentRef: 'ed:7:11' };
it('retains strict validation of historical audit metadata', () => {
  expect(auditSchema.parse(record)).toEqual(record);
  expect(auditSchema.safeParse({ ...record, answer: 'PRIVATE-SENTINEL' }).success).toBe(false);
  expect(auditSchema.safeParse({ ...record, assessmentRef: '../unsafe' }).success).toBe(false);
});
