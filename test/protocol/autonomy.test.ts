import { expect, it, vi } from 'vitest';
import { AssessmentAutonomy } from '../../src/protocol/autonomy.js';
import type { AuthorizationStore } from '../../src/protocol/authorization.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
const target = { assessmentId: 'a', courseId: 'c', category: 'assignment' as const };
const policy = { version: 1, courseId: 'c', status: 'owner-attested', cap: 4, attestation: 'Synthetic', date: '2026-10-14' };
const grant = { version: 1, ...target, level: 4, date: '2026-10-14' };
function setup(p: unknown = policy, g: unknown = grant, t: unknown = target) {
  const store = { target: async () => t, policy: async () => p && ({ record: p, ref: 'a'.repeat(64) }),
    grant: async () => g && ({ record: g, ref: 'b'.repeat(64) }) } as unknown as AuthorizationStore;
  const events: unknown[] = []; const audit = { record: vi.fn(async (event: unknown) => { events.push(event); }) };
  return { service: new AssessmentAutonomy(store, audit), audit, events };
}
it.each([
  ['policy-missing', null, grant, target],
  ['course-prohibited', { ...policy, status: 'prohibited', cap: 1 }, grant, target],
  ['exam', policy, grant, { ...target, category: 'exam' }],
  ['kind-unknown', policy, grant, { ...target, category: 'unknown' }],
  ['grant-missing', policy, null, target],
  ['grant-mismatch', policy, { ...grant, assessmentId: 'b' }, target],
  ['grant-mismatch', policy, { ...grant, courseId: 'other' }, target],
  ['grant-revoked', policy, { ...grant, level: 0 }, target],
  ['grant-level', policy, { ...grant, level: 2 }, target],
  ['course-cap', { ...policy, cap: 2 }, grant, target],
])('denies %s and appends safe metadata', async (reason, p, g, t) => {
  const { service, events } = setup(p, g, t);
  expect(await service.check({ assessmentId: 'a', level: 3 })).toEqual({ decision: 'denied', reason });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ assessmentId: 'a', level: 3, decision: 'denied', reason });
  expect(JSON.stringify(events)).not.toContain('Synthetic');
});
it('allows L0/L1 without policy and granted L2–L4, rereading revocation', async () => {
  const low = setup(null, null);
  for (const level of [0, 1] as const) expect(await low.service.check({ assessmentId: 'a', level })).toEqual({ decision: 'allowed', reason: 'allowed' });
  const { service, events } = setup();
  for (const level of [2, 3, 4] as const) expect(await service.check({ assessmentId: 'a', level })).toEqual({ decision: 'allowed', reason: 'allowed' });
  expect(events).toHaveLength(3);
});
it('returns denied audit-unavailable even through dispatch when the journal is broken', async () => {
  const { service, audit } = setup(); audit.record.mockRejectedValue(new Error('secret raw error'));
  const context = createFakeContext(); context.audit.record = async () => { throw Error('secret'); };
  const result = await dispatch(createRegistry({ autonomy: service }), 'autonomy.check', { assessmentId: 'a', level: 3 }, context);
  expect(result).toMatchObject({ ok: true, data: { decision: 'denied', reason: 'audit-unavailable' } });
  expect(JSON.stringify(result)).not.toContain('secret');
});
it.each([undefined, 'owner-chat'] as const)('records L4 submit with confirmation %s', async confirmation => {
  const { service, events } = setup();
  expect(await service.record({ assessmentId: 'a', level: 4, action: 'submit', outcome: 'success', ...(confirmation ? { confirmation } : {}) })).toEqual({ recorded: true, outcome: confirmation ? 'success' : 'violation' });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ level: 4, action: 'submit', outcome: confirmation ? 'success' : 'violation', policyRef: 'a'.repeat(64), grantRef: 'b'.repeat(64) });
});
it('refuses arbitrary prose, answers, personal data and confirmation text', async () => {
  const { service, events } = setup(); const context = createFakeContext();
  for (const extra of [{ answers: 'private' }, { outcome: 'email@example.invalid' }, { confirmation: 'my password' }, { assessmentId: 'email@example.invalid' }]) {
    expect(await dispatch(createRegistry({ autonomy: service }), 'audit.record', { assessmentId: 'a', level: 3, action: 'fill', outcome: 'success', ...extra }, context)).toMatchObject({ ok: false });
  }
  expect(events).toHaveLength(0);
});
it('shared journal outage returns audit-unavailable rather than preempting the check', async () => {
  const { service, audit } = setup(); audit.record.mockRejectedValue(new Error('private storage failure'));
  const context = createFakeContext();
  context.runs.record = context.audit.record = async () => { throw new Error('private storage failure'); };
  expect(await dispatch(createRegistry({ autonomy: service }), 'autonomy.check', { assessmentId: 'a', level: 3 }, context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'audit-unavailable' } });
});
it('validation denials receive safe audit without echoing invalid input', async () => {
  const { service } = setup(); const context = createFakeContext();
  expect(await dispatch(createRegistry({ autonomy: service }), 'autonomy.check', { assessmentId: 'private prose', level: 9 }, context)).toMatchObject({ ok: false });
  expect(context.events).toHaveLength(1);
  expect(context.events[0]).toMatchObject({ command: 'autonomy.check', phase: 'denial', code: 'INVALID_INPUT' });
  expect(JSON.stringify(context.events)).not.toContain('private prose');
});
it('records actual writes even when permission references cannot be read', async () => {
  const events: unknown[] = [];
  const store = { target: async () => target, policy: async () => { throw Error('private'); }, grant: async () => { throw Error('private'); } } as unknown as AuthorizationStore;
  const service = new AssessmentAutonomy(store, { record: async event => { events.push(event); } });
  expect(await service.record({ assessmentId: 'a', level: 3, action: 'fill', outcome: 'success' })).toEqual({ recorded: true, outcome: 'success' });
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ assessmentId: 'a', courseId: 'c', action: 'fill' });
  expect(JSON.stringify(events)).not.toContain('private');
});
it('audits only the canonical target reference and looks up its grant', async () => {
  const events: unknown[] = [];
  const grantLookup = vi.fn(async () => ({ record: grant, ref: 'b'.repeat(64) }));
  const store = { target: async () => target, policy: async () => ({ record: policy, ref: 'a'.repeat(64) }),
    grant: grantLookup } as unknown as AuthorizationStore;
  const service = new AssessmentAutonomy(store, { record: async event => { events.push(event); } });
  const assessmentId = 'synthetic-alias';
  expect(await service.check({ assessmentId, level: 3 })).toEqual({ decision: 'allowed', reason: 'allowed' });
  expect(await service.record({ assessmentId, level: 3, action: 'fill', outcome: 'success' }))
    .toEqual({ recorded: true, outcome: 'success' });
  expect(grantLookup.mock.calls).toEqual([['a'], ['a']]);
  expect(events).toHaveLength(2);
  for (const event of events) expect(event).toMatchObject({ assessmentId: 'a', courseId: 'c' });
  expect(JSON.stringify(events)).not.toContain(assessmentId);
});
it('denies unresolved targets and preserves unconfirmed L4 violations without request references', async () => {
  const events: unknown[] = [];
  const store = { target: async () => { throw Error('private target failure'); } } as unknown as AuthorizationStore;
  const service = new AssessmentAutonomy(store, { record: async event => { events.push(event); } });
  const assessmentId = 'Jane.Doe/answer-is-42';
  expect(await service.check({ assessmentId, level: 1 })).toEqual({ decision: 'denied', reason: 'assessment-unavailable' });
  expect(await service.record({ assessmentId, level: 4, action: 'submit', outcome: 'success' }))
    .toEqual({ recorded: true, outcome: 'violation' });
  expect(events).toHaveLength(2);
  for (const event of events) expect(event).not.toHaveProperty('assessmentId');
  expect(JSON.stringify(events)).not.toContain(assessmentId);
  expect(JSON.stringify(events)).not.toContain('private target failure');
});
it.each(['policy', 'grant'] as const)('keeps the resolved target in the audit when the %s read fails', async failing => {
  const store = { target: async () => target,
    policy: async () => { if (failing === 'policy') throw new Error('unreadable'); return { record: policy, ref: 'a'.repeat(64) }; },
    grant: async () => { if (failing === 'grant') throw new Error('unreadable'); return { record: grant, ref: 'b'.repeat(64) }; } } as unknown as AuthorizationStore;
  const events: unknown[] = []; const service = new AssessmentAutonomy(store, { record: async (event: unknown) => { events.push(event); } } as never);
  expect(await service.check({ assessmentId: 'a', level: 3 })).toEqual({ decision: 'denied', reason: 'authorization-unavailable' });
  expect(events[0]).toMatchObject({ assessmentId: 'a', courseId: 'c', decision: 'denied', reason: 'authorization-unavailable' });
});
