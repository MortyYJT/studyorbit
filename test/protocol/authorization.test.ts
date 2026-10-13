import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedAuthorization, Q1AuthorizationStore, IdentityMap } from '../../src/protocol/authorization.js';
import { DurableAudit, DurableRuns } from '../../src/protocol/audit.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { hash } from '../../src/citations/exact.js';
import { dispatch, createRegistry, Registry } from '../../src/protocol/registry.js';
import { createFakeContext, examples } from '../../src/protocol/fakes.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const binding = { assessmentId: 'legacy-assessment', course: '7', lesson: '11', category: 'assignment' as const };
const policy = { version: 1 as const, course: '7', status: 'owner-attested' as const, attestation: 'Synthetic permission', date: '2026-10-12', cap: 4 };
const grant = { version: 1 as const, binding, level: 4, date: '2026-10-12' };
const mappings = { courses: [{ courseId: 'course-a', edCourse: '7' }], assessments: [{ assessmentId: 'assessment-a', courseId: 'course-a', binding }] };
const owner = { assertOwner: vi.fn(async () => {}) };
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'authorization-'))); roots.push(root);
  const files = new ProtocolFiles(root);
  await files.write('policy-7', policy); await files.write(`binding-${hash(binding.assessmentId)}`, binding);
  await files.write(`grant-${hash(binding.assessmentId)}`, grant);
  const store = new Q1AuthorizationStore(files, new IdentityMap(mappings));
  const audit = new DurableAudit(files);
  return { root, files, store, audit, service: new SharedAuthorization(store, audit) };
}
it('checks policy/grant matrix and live revocation without caching permissions', async () => {
  const { files, service } = await setup();
  for (const level of [0, 1, 2, 3, 4] as const) await service.check('assessment.action', level, { assessmentId: 'assessment-a' });
  for (const status of ['allowed', 'owner-attested', 'prohibited'] as const) {
    const p = status === 'owner-attested' ? policy : { version: 1, course: '7', status, quote: 'Synthetic rule', locator: 'policy:1', cap: status === 'prohibited' ? 1 : 4 };
    await files.write('policy-7', p);
    await service.check('study', 1, {});
    if (status === 'prohibited') await expect(service.check('assessment.action', 2, { assessmentId: 'assessment-a' })).rejects.toThrow();
    else await service.check('assessment.action', 4, { assessmentId: 'assessment-a' });
  }
  await files.write('policy-7', { ...policy, cap: 2 });
  await expect(service.check('revision.write', 2, { assessmentId: 'assessment-a' })).rejects.toThrow();
  await files.write('policy-7', policy); await files.write(`grant-${hash(binding.assessmentId)}`, { ...grant, level: 0 });
  await expect(service.check('assessment.action', 4, { assessmentId: 'assessment-a' })).rejects.toThrow();
});
it.each(['exam', 'unknown'] as const)('caps trusted %s classification at L1', async category => {
  const { files, audit } = await setup(); const b = { ...binding, category };
  await files.write(`binding-${hash(binding.assessmentId)}`, b); await files.write(`grant-${hash(binding.assessmentId)}`, { ...grant, binding: b });
  const service = new SharedAuthorization(new Q1AuthorizationStore(files, new IdentityMap({ ...mappings, assessments: [{ ...mappings.assessments[0]!, binding: b }] })), audit);
  await service.check('study', 1, {});
  await expect(service.check('assessment.action', 2, { assessmentId: 'assessment-a' })).rejects.toThrow();
});
it('fails closed for absent/malformed policies, wrong course/assessment/grant and stale refs', async () => {
  const { files, service } = await setup();
  for (const p of [undefined, { ...policy, course: '8' }, { ...policy, date: '2026-02-30' }]) {
    await files.write('policy-7', p ?? null);
    await expect(service.check('assessment.action', 4, { assessmentId: 'assessment-a' })).rejects.toThrow();
  }
  await files.write('policy-7', policy);
  for (const g of [{ ...grant, binding: { ...binding, assessmentId: 'other' } }, null]) {
    await files.write(`grant-${hash(binding.assessmentId)}`, g);
    await expect(service.check('assessment.action', 4, { assessmentId: 'assessment-a' })).rejects.toThrow();
  }
  await files.write(`grant-${hash(binding.assessmentId)}`, grant);
  for (const input of [{ assessmentId: 'other' }, { assessmentId: 'assessment-a', courseId: 'other' },
    { assessmentId: 'assessment-a', policyRef: 'a'.repeat(64) }, { assessmentId: 'assessment-a', grantRef: 'a'.repeat(64) }]) {
    await expect(service.check('assessment.action', 4, input)).rejects.toThrow();
  }
  await service.check('revision.write', 2, { binding });
});
it('requires owner recording and uses one Q1 authority with original hashes and default-off settings', async () => {
  const { files, service, store } = await setup();
  const input = { version: 1, courseId: 'course-a', status: 'allowed', quote: 'Synthetic rule', locator: 'policy:1', cap: 4 };
  await expect(service.recordPolicy(input)).rejects.toThrow();
  const receipt = await service.recordPolicy(input, owner);
  expect(receipt).toMatchObject({ courseId: 'course-a', status: 'allowed', policyRef: hash(await files.read('policy-7')) });
  expect(await files.records('policy-')).toEqual(['policy-7']);
  const revoked = await service.recordGrant({ version: 1, courseId: 'course-a', assessmentId: 'assessment-a', category: 'assignment', level: 0, date: '2026-10-12' }, owner);
  expect(revoked.grantRef).toBe(hash(await files.read(`grant-${hash(binding.assessmentId)}`)));
  expect(await service.autoSubmit('course-a')).toBe(false);
  const settings = new Map<string, boolean>();
  const enabled = new SharedAuthorization(store, new DurableAudit(files), { get: async id => settings.get(id) ?? false, set: async (id, value) => { settings.set(id, value); } });
  await expect(enabled.setAutoSubmit('course-a', true)).rejects.toThrow();
  await enabled.setAutoSubmit('course-a', true, owner);
  expect(await enabled.autoSubmit('course-a')).toBe(true);
  await expect(enabled.check('assessment.action', 4, { assessmentId: 'assessment-a' })).rejects.toThrow();
});
it('rejects ambiguous maps, symlinks and interrupted/unbound activation without modifying records', async () => {
  expect(() => new IdentityMap({ ...mappings, courses: [...mappings.courses, { courseId: 'other', edCourse: '7' }] })).toThrow();
  expect(() => new IdentityMap({ ...mappings, assessments: [...mappings.assessments, { ...mappings.assessments[0]!, assessmentId: 'other' }] })).toThrow();
  const { root, files, service } = await setup();
  await files.write(`binding-${hash(binding.assessmentId)}`, { ...binding, lesson: '12' });
  const before = await readFile(join(root, 'quiz', `grant-${hash(binding.assessmentId)}.json`), 'utf8');
  await expect(service.check('assessment.action', 4, { assessmentId: 'assessment-a' })).rejects.toThrow();
  expect(await readFile(join(root, 'quiz', `grant-${hash(binding.assessmentId)}.json`), 'utf8')).toBe(before);
  const victim = join(root, 'victim'); await writeFile(victim, 'private sentinel');
  await symlink(victim, join(root, 'quiz', 'policy-8.json'));
  await expect(files.read('policy-8')).rejects.toThrow();
  await expect(files.read('../unsafe')).rejects.toThrow();
});
it('append-only audits accept safe refs and keep operational runs separate, refusing unsafe metadata', async () => {
  const { root, files, audit } = await setup(); const runs = new DurableRuns(files);
  const event = { command: 'revision.write', runId: examples['audit.list'].output.items[0]!.runId, phase: 'intent' as const, code: 'OK' as const, assessmentId: 'assessment-a', policyRef: hash(policy) };
  await audit.record(event); await audit.record({ ...event, phase: 'denial', code: 'CITATION_MISMATCH' });
  await runs.record({ ...event, phase: 'denial', code: 'CITATION_MISMATCH' });
  expect((await audit.list()).length).toBe(2);
  const before = await readFile(join(root, 'quiz', 'audit.jsonl'), 'utf8');
  await expect(audit.record({ ...event, answer: 'secret prose' } as never)).rejects.toThrow();
  expect(await readFile(join(root, 'quiz', 'audit.jsonl'), 'utf8')).toBe(before);
  expect(await readFile(join(root, 'quiz', 'runs.jsonl'), 'utf8')).toContain('CITATION_MISMATCH');
  expect(before).not.toContain('Synthetic permission');
});
it('fails before recording mutation when intent is unavailable', async () => {
  const { files, store } = await setup(); const before = await files.read('policy-7');
  const audit = { record: vi.fn(async () => { throw new Error('credentials sentinel'); }) };
  const service = new SharedAuthorization(store, audit);
  await expect(service.recordPolicy({ version: 1, courseId: 'course-a', status: 'allowed', cap: 4, quote: 'Synthetic', locator: 'p' }, owner)).rejects.toThrow();
  expect(await files.read('policy-7')).toEqual(before);
});
it.each(['policy.record', 'grant.record'] as const)('rejects %s service receipts bound to another target', async name => {
  const context = createFakeContext({ owner: true });
  context.services.write = vi.fn(async () => ({ ...examples[name].output, courseId: 'wrong', ...(name === 'grant.record' ? { assessmentId: 'wrong' } : {}) })) as typeof context.services.write;
  expect(await dispatch(createRegistry(), name, examples[name].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
});
it('reports uncertain after successful mutation with failed outcome audit and never retries', async () => {
  const context = createFakeContext(); const calls = vi.spyOn(context.services, 'write');
  context.audit.record = vi.fn(async event => { if (event.phase === 'outcome') throw new Error('private sentinel'); });
  expect(await dispatch(createRegistry(), 'revision.write', examples['revision.write'].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
  expect(calls).toHaveBeenCalledOnce();
});

it('records a first exact binding only through owner action and refuses an orphan grant', async () => {
  const { root, files, audit } = await setup();
  const b = { ...binding, assessmentId: 'second-legacy', lesson: '12' };
  const ids = new IdentityMap({ courses: mappings.courses, assessments: [{ courseId: 'course-a', assessmentId: 'second-canonical', binding: b }] });
  const store = new Q1AuthorizationStore(files, ids); const service = new SharedAuthorization(store, audit);
  await files.write(`grant-${hash(b.assessmentId)}`, { ...grant, binding: b });
  await expect(service.check('assessment.action', 4, { assessmentId: 'second-canonical' })).rejects.toThrow();
  const before = await readFile(join(root, 'quiz', `grant-${hash(b.assessmentId)}.json`), 'utf8');
  expect(before).toContain('second-legacy');
  await service.recordGrant({ version: 1, courseId: 'course-a', assessmentId: 'second-canonical', category: 'assignment', level: 2, date: '2026-10-12' }, owner);
  await service.check('revision.write', 2, { assessmentId: 'second-canonical' });
  await expect(service.check('assessment.action', 3, { assessmentId: 'second-canonical' })).rejects.toThrow();
});
it('audits safe canonical target refs on dispatch and records citation denial in both journals', async () => {
  const { root, files, service, audit } = await setup();
  const context = createFakeContext(); context.authorization = service; context.audit = audit; context.runs = new DurableRuns(files);
  context.evidence.check = async () => { throw new (await import('../../src/protocol/errors.js')).CourseworkError('CITATION_MISMATCH', 'rejected prose sentinel'); };
  const input = { binding };
  expect(await dispatch(assessmentRegistry(), 'breakdown.write', input, context)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect((await audit.list()).at(-1)).toMatchObject({ phase: 'denial', courseId: 'course-a', assessmentId: 'assessment-a', policyRef: hash(policy), grantRef: hash(grant) });
  expect(await readFile(join(root, 'quiz', 'runs.jsonl'), 'utf8')).toContain('CITATION_MISMATCH');
  expect(await readFile(join(root, 'quiz', 'audit.jsonl'), 'utf8')).not.toContain('rejected prose sentinel');
});
it('completion audit failure after owner recording reports uncertainty and preserves the actual record', async () => {
  const { files, store } = await setup();
  const service = new SharedAuthorization(store, { record: async event => { if (event.phase === 'outcome') throw Error('private sentinel'); } });
  await expect(service.recordPolicy({ version: 1, courseId: 'course-a', status: 'allowed', cap: 3, quote: 'Synthetic rule', locator: 'p:1' }, owner)).rejects.toMatchObject({ code: 'UNCERTAIN' });
  expect(await files.read('policy-7')).toMatchObject({ status: 'allowed', cap: 3 });
});
it('refuses malformed/partial logs without rewriting history', async () => {
  const { root, audit } = await setup(); const path = join(root, 'quiz', 'audit.jsonl');
  await writeFile(path, '{"incomplete":');
  await expect(audit.list()).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{"incomplete":');
});
it('authorization denials retain verified target refs and owner intents identify the target before publication', async () => {
  const { files, service, audit } = await setup();
  await files.write(`grant-${hash(binding.assessmentId)}`, { ...grant, level: 0 });
  const context = createFakeContext(); context.authorization = service; context.audit = audit;
  expect(await dispatch(assessmentRegistry(), 'breakdown.write', { binding }, context)).toMatchObject({ ok: false });
  expect((await audit.list()).at(-1)).toMatchObject({ phase: 'denial', courseId: 'course-a', assessmentId: 'assessment-a' });
  await service.recordGrant({ version: 1, courseId: 'course-a', assessmentId: 'assessment-a', category: 'assignment', level: 1, date: '2026-10-12' }, owner);
  expect((await audit.list()).slice(-2)).toMatchObject([
    { command: 'grant.record', phase: 'intent', courseId: 'course-a', assessmentId: 'assessment-a' },
    { command: 'grant.record', phase: 'outcome', courseId: 'course-a', assessmentId: 'assessment-a' },
  ]);
});
it('does not rewrite an existing binding when updating a grant, and exposes partial publication uncertainty', async () => {
  const { files, service, audit } = await setup();
  const write = vi.spyOn(files, 'write');
  await service.recordGrant({ version: 1, courseId: 'course-a', assessmentId: 'assessment-a', category: 'assignment', level: 2, date: '2026-10-12' }, owner);
  expect(write.mock.calls.map(args => args[0])).toEqual([`grant-${hash(binding.assessmentId)}`]);
  const original = files.write.bind(files);
  write.mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new (await import('../../src/protocol/errors.js')).CourseworkError('UNCERTAIN', 'Synthetic post-publication sync failure');
  });
  await expect(service.recordGrant({ version: 1, courseId: 'course-a', assessmentId: 'assessment-a', category: 'assignment', level: 1, date: '2026-10-12' }, owner)).rejects.toMatchObject({ code: 'UNCERTAIN' });
  expect((await audit.list()).at(-1)).toMatchObject({ phase: 'outcome', code: 'UNCERTAIN', grantRef: hash(await files.read(`grant-${hash(binding.assessmentId)}`)) });
});

function assessmentRegistry() {
  const registry = new Registry();
  registry.register({ name: 'breakdown.write', level: 2, input: z.strictObject({ binding: z.unknown() }), output: z.strictObject({}), handler: () => ({}) });
  return registry;
}
