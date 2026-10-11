import { expect, it } from 'vitest';
import * as schemas from '../../src/domain/schemas.js';

const historical = { id: 'run-legacy', command: 'sync', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', steps: 1, outcome: 'ok' };
const scope = { provider: 'canvas', scopeRef: 'a'.repeat(64), collection: 'assignments', planned: 1, attempted: 1, completed: 0, skipped: 0, failed: 1, notStarted: 0, codes: ['AUTH_EXPIRED'] };
const measured = { ...historical, outcome: 'error', errorCode: 'AUTH_EXPIRED', pages: 0, requests: 1, failures: 1, coverage: [scope] };

it('keeps historical sync and non-sync runs readable without backfilling metrics (2.3)', () => {
  expect(schemas.RunSchema.parse(historical)).toEqual(historical);
  expect(schemas.RunSchema.parse({ ...historical, command: 'quiz.read' })).toEqual({ ...historical, command: 'quiz.read' });
});
it('retains measured source coverage and requires it at new sync finalization (2.3)', () => {
  expect(schemas.RunSchema.parse(measured)).toEqual(measured);
  const sync = schemas.SyncRunSchema;
  expect(sync).toBeDefined();
  expect(sync.parse(measured)).toEqual(measured);
  expect(sync.safeParse(historical).success).toBe(false);
  expect(sync.safeParse({ ...measured, command: 'quiz.read' }).success).toBe(false);
  for (const field of ['pages', 'requests', 'failures', 'coverage']) {
    const input: Record<string, unknown> = { ...measured };
    delete input[field];
    expect(sync.safeParse(input).success).toBe(false);
  }
});
it('rejects invalid measured counts and partial metric groups (2.3)', () => {
  for (const field of ['pages', 'requests', 'failures']) {
    for (const value of [-1, 0.5, Infinity, NaN]) {
      expect(schemas.RunSchema.safeParse({ ...measured, [field]: value }).success).toBe(false);
    }
  }
  for (const field of ['planned', 'attempted', 'completed', 'skipped', 'failed', 'notStarted']) {
    for (const value of [-1, 0.5, Infinity]) {
      expect(schemas.RunSchema.safeParse({ ...measured, coverage: [{ ...scope, [field]: value }] }).success).toBe(false);
    }
  }
  expect(schemas.RunSchema.safeParse({ ...historical, requests: 1 }).success).toBe(false);
});
it('rejects unsafe or unrecognized coverage rather than stripping it (2.3)', () => {
  for (const patch of [
    { provider: 'ical' }, { scopeRef: 'https://example.invalid/private?token=sentinel' },
    { scopeRef: 'Synthetic Student' }, { collection: 'private answer text' },
    { codes: ['token=sentinel'] }, { error: 'private raw error' }, { quote: 'private answer' },
  ]) {
    expect(schemas.RunSchema.safeParse({ ...measured, coverage: [{ ...scope, ...patch }] }).success).toBe(false);
  }
});
it('accepts zero work and each provider/scope outcome without inventing cost (2.3)', () => {
  const zero = { ...historical, pages: 0, requests: 0, failures: 0, coverage: [] };
  expect(schemas.RunSchema.parse(zero)).toEqual(zero);
  const ed = { ...scope, provider: 'ed', collection: 'lessons', attempted: 0, failed: 0, notStarted: 1, codes: ['CANCELED'] };
  expect(schemas.RunSchema.parse({ ...measured, coverage: [scope, ed] })).toEqual({ ...measured, coverage: [scope, ed] });
});
