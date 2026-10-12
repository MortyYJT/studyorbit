import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizFiles } from '../../src/quiz/files.js';
import { FileEvidence, proposeQuiz, recordOwnerAction } from '../../src/quiz/proposals.js';
import { reviewQuiz } from '../../src/quiz/review.js';
import { hash } from '../../src/quiz/citations.js';
import { SharedAuthorization, Q1AuthorizationStore, IdentityMap } from '../../src/protocol/authorization.js';
import { DurableAudit } from '../../src/protocol/audit.js';
import { GatedQuizActions, Q1ReviewPreflight, SingleUseConfirmations, InMemoryFilledStore,
  type FillDriver, type SubmitDriver } from '../../src/protocol/actions.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { protectRead } from '../../src/protocol/read-privacy.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import type { FilledTarget } from '../../src/protocol/contracts.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const binding = { assessmentId: 'legacy-quiz', course: '7', lesson: '11', category: 'assignment' as const };
const page = { course: '7', lesson: '11', pageId: 'synthetic-page', attemptId: '41' };
const q = 'ed:7:11:21:31';
const data = { assessmentRef: 'ed:7:11', questions: [{ ref: q, supported: true, type: 'text', prompt: 'Synthetic question?' }],
  sources: [{ sourceItemId: q, text: 'Synthetic question?', locator: 'question:31' }],
  coverage: { complete: true, scope: 'assessment', total: 1, supported: 1, unsupported: 0 } };
const answer = { questionRef: q, answer: 'Synthetic answer.', rationale: 'Own reasoning.', citations: [{ sourceItemId: q, quote: 'Synthetic question?', locator: 'question:31' }],
  statements: [{ field: 'answer', text: 'Synthetic answer.', kind: 'reasoning' }, { field: 'rationale', text: 'Own reasoning.', kind: 'reasoning' }] };
const identities = { courses: [{ courseId: 'course-a', edCourse: '7' }], assessments: [{ assessmentId: 'quiz-a', courseId: 'course-a', binding }] };
const policy = { version: 1, course: '7', status: 'owner-attested', attestation: 'Synthetic permission', date: '2026-10-12', cap: 4 };
const owner = { assertOwner: vi.fn(async () => {}) };

function drivers() {
  const calls: string[] = [];
  const fill: FillDriver = { fill: vi.fn(async target => { calls.push('fill'); return { status: 'filled' as const,
    target: { ...target, filledRevision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }; }) };
  const submit: SubmitDriver = { submit: vi.fn(async target => { calls.push('submit'); return { status: 'submitted' as const, target }; }) };
  return { calls, fill, submit };
}
async function setup(options: { level?: number; submit?: boolean; autoSubmit?: boolean; now?: () => number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'actions-'))); roots.push(root);
  const files = new QuizFiles(root); const tty = { files, isTTY: true, confirm: async () => true };
  await recordOwnerAction('policy', policy, tty);
  await recordOwnerAction('grant', { version: 1, binding, level: options.level ?? 3, date: '2026-10-12' }, tty);
  await new FileEvidence(files).saveRead(data);
  const proposed = await proposeQuiz({ version: 1, binding, sourceRevision: hash(data), answers: [answer] }, tty);
  if (!proposed.ok) throw new Error('synthetic proposal failed');
  const revision = (proposed.data as { revision: string }).revision;
  const reviewed = await reviewQuiz({ assessmentId: binding.assessmentId, revision, page }, { files, isTTY: true, display: () => {}, decide: async () => 'approve' });
  if (!reviewed.ok) throw new Error('synthetic review failed');
  const map = new IdentityMap(identities); const audit = new DurableAudit(files);
  const settings = new Map<string, boolean>([['course-a', options.autoSubmit === true]]);
  const authorization = new SharedAuthorization(new Q1AuthorizationStore(files, map), audit,
    { get: async id => settings.get(id) ?? false, set: async (id, value) => { settings.set(id, value); } });
  const d = drivers(); const filled = new InMemoryFilledStore();
  const confirmations = new SingleUseConfirmations(options.now ? { now: options.now } : {});
  const actions = new GatedQuizActions({ authorization, review: new Q1ReviewPreflight(files, map), filled, confirmations,
    fill: d.fill, ...(options.submit === false ? {} : { submit: d.submit }) });
  // Production read-privacy boundary: identifiers/revisions are validated, never prose-redacted.
  const context = createFakeContext(); context.authorization = authorization; context.actions = actions;
  context.privacy = { protect: async (_command, value) => protectRead(value) };
  const target = { assessmentId: 'quiz-a', revision, sourceRevision: hash(data), page,
    policyRef: hash(await files.read('policy-7')), grantRef: hash(await files.read(`grant-${hash(binding.assessmentId)}`)) };
  return { root, files, tty, actions, context, target, filled, confirmations, settings, registry: createRegistry(), ...d };
}
async function fill(f: Awaited<ReturnType<typeof setup>>): Promise<FilledTarget> {
  const result = await dispatch(f.registry, 'quiz.fill', f.target, f.context);
  if (!result.ok || (result.data as { status: string }).status !== 'filled') throw new Error(`fill failed: ${JSON.stringify(result)}`);
  return (result.data as { target: FilledTarget }).target;
}

describe('8.3 L3 fill gate', () => {
  it('fills once with the exact reviewed revision and never submits; L3 cannot submit', async () => {
    const f = await setup({ level: 3 });
    const filled = await fill(f);
    expect(filled).toMatchObject({ ...f.target, filledRevision: expect.any(String) });
    expect(f.calls).toEqual(['fill']);
    expect(await f.filled.get('quiz-a')).toEqual(filled);
    const token = (await f.actions.requestConfirmation(filled, owner)).token;
    expect(await dispatch(f.registry, 'quiz.submit', { ...filled, confirmationToken: token }, f.context)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.calls).toEqual(['fill']);
    const actionEvents = f.context.events.filter(e => e.command === 'quiz.fill');
    expect(actionEvents.some(e => e.phase === 'intent' && e.revision === f.target.revision && e.grantRef === f.target.grantRef)).toBe(true);
  });

  it('refuses stale review, page, attempt, policy and revoked grant before any action', async () => {
    const f = await setup({ level: 3 });
    for (const changed of [{ ...f.target, revision: '00000000-0000-4000-8000-000000000000' },
      { ...f.target, page: { ...page, attemptId: '42' } }, { ...f.target, page: { ...page, pageId: 'other-page' } },
      { ...f.target, sourceRevision: 'f'.repeat(64) }, { ...f.target, policyRef: 'f'.repeat(64) }, { ...f.target, grantRef: 'f'.repeat(64) }]) {
      expect(await dispatch(f.registry, 'quiz.fill', changed, f.context), JSON.stringify(changed)).toMatchObject({ ok: false });
    }
    await recordOwnerAction('grant', { version: 1, binding, level: 2, date: '2026-10-12' }, f.tty);
    expect(await dispatch(f.registry, 'quiz.fill', { ...f.target, grantRef: hash(await f.files.read(`grant-${hash(binding.assessmentId)}`)) }, f.context)).toMatchObject({ ok: false });
    await recordOwnerAction('grant', { version: 1, binding, level: 0, date: '2026-10-12' }, f.tty);
    expect(await dispatch(f.registry, 'quiz.fill', f.target, f.context)).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
    expect(await f.filled.get('quiz-a')).toBeUndefined();
  });

  it('holds an exclusive assessment action lock and refuses unsupported controls without a retry', async () => {
    const f = await setup({ level: 3 });
    let release!: () => void;
    (f.fill.fill as ReturnType<typeof vi.fn>).mockImplementationOnce(async target => {
      f.calls.push('fill'); await new Promise<void>(resolve => { release = resolve; });
      return { status: 'filled', target: { ...target, filledRevision: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } };
    });
    const first = f.actions.fill(f.target, f.context);
    await vi.waitFor(() => expect(f.calls).toEqual(['fill']));
    await expect(f.actions.fill(f.target, f.context)).rejects.toMatchObject({ code: 'LOCKED' });
    release(); await first;
    (f.fill.fill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CourseworkError('SOURCE_UNAVAILABLE', 'unsupported control'));
    await f.filled.clear('quiz-a');
    expect(await dispatch(f.registry, 'quiz.fill', f.target, f.context)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(f.fill.fill).toHaveBeenCalledTimes(2);
    expect(await f.filled.get('quiz-a')).toBeUndefined();
  });
});

describe('8.4 L4 submit gate', () => {
  it('requires a single-use owner confirmation by default and returns safe unavailable without an adapter', async () => {
    const f = await setup({ level: 4, submit: false });
    const filled = await fill(f);
    expect(await dispatch(f.registry, 'quiz.submit', filled, f.context)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(f.actions.requestConfirmation(filled, undefined)).rejects.toThrow();
    const { token } = await f.actions.requestConfirmation(filled, owner);
    expect(owner.assertOwner).toHaveBeenCalledWith('quiz.submit');
    expect(await dispatch(f.registry, 'quiz.submit', { ...filled, confirmationToken: token }, f.context))
      .toMatchObject({ ok: true, data: { status: 'unavailable', reason: 'SOURCE_UNAVAILABLE' } });
    expect(f.calls).toEqual(['fill']);
    expect(await f.filled.get('quiz-a')).toEqual(filled);
  });

  it('submits once with exact confirmation and rejects replayed, stale, cross-target, forged and expired confirmations', async () => {
    let now = 0;
    const f = await setup({ level: 4, now: () => now });
    const filled = await fill(f);
    const forged = 'A'.repeat(43);
    expect(await dispatch(f.registry, 'quiz.submit', { ...filled, confirmationToken: forged }, f.context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const cross = await f.confirmations.issue({ ...filled, page: { ...page, attemptId: '99' } }, owner);
    expect(await dispatch(f.registry, 'quiz.submit', { ...filled, confirmationToken: cross.token }, f.context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const expired = await f.actions.requestConfirmation(filled, owner); now += 10 * 60 * 1000;
    expect(await dispatch(f.registry, 'quiz.submit', { ...filled, confirmationToken: expired.token }, f.context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const stale = await f.actions.requestConfirmation(filled, owner);
    const moved = { ...filled, filledRevision: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    await f.filled.put(moved);
    expect(await dispatch(f.registry, 'quiz.submit', { ...filled, confirmationToken: stale.token }, f.context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await dispatch(f.registry, 'quiz.submit', { ...moved, confirmationToken: stale.token }, f.context)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.submit.submit).not.toHaveBeenCalled();
    const { token } = await f.actions.requestConfirmation(moved, owner);
    expect(await dispatch(f.registry, 'quiz.submit', { ...moved, confirmationToken: token }, f.context)).toMatchObject({ ok: true, data: { status: 'submitted', target: moved } });
    expect(await dispatch(f.registry, 'quiz.submit', { ...moved, confirmationToken: token }, f.context)).toMatchObject({ ok: false });
    expect(f.submit.submit).toHaveBeenCalledOnce();
    expect(await f.filled.get('quiz-a')).toBeUndefined();
  });

  it('auto-submit removes only the confirmation step, never revocation or the exam gate', async () => {
    const f = await setup({ level: 4, autoSubmit: true });
    const filled = await fill(f);
    expect(await dispatch(f.registry, 'quiz.submit', filled, f.context)).toMatchObject({ ok: true, data: { status: 'submitted' } });
    const g = await setup({ level: 4, autoSubmit: true });
    const second = await fill(g);
    await recordOwnerAction('grant', { version: 1, binding, level: 3, date: '2026-10-12' }, g.tty);
    expect(await dispatch(g.registry, 'quiz.submit', { ...second, grantRef: hash(await g.files.read(`grant-${hash(binding.assessmentId)}`)) }, g.context)).toMatchObject({ ok: false });
    const exam = { ...binding, category: 'exam' as const };
    await g.files.write(`binding-${hash(binding.assessmentId)}`, exam);
    await g.files.write(`grant-${hash(binding.assessmentId)}`, { version: 1, binding: exam, level: 4, date: '2026-10-12' });
    expect(await dispatch(g.registry, 'quiz.submit', second, g.context)).toMatchObject({ ok: false });
    expect(g.submit.submit).not.toHaveBeenCalled();
  });

  it('refuses submit for proposals or approvals that were never filled', async () => {
    const f = await setup({ level: 4, autoSubmit: true });
    expect(await dispatch(f.registry, 'quiz.submit', { ...f.target, filledRevision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, f.context))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.calls).toEqual([]);
  });
});

describe('8.5 audit and external uncertainty', () => {
  it('blocks the action when its intent audit fails', async () => {
    const f = await setup({ level: 4, autoSubmit: true });
    f.context.audit.record = async () => { throw new Error('audit down sentinel'); };
    await expect(f.actions.fill(f.target, f.context)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    let intents = 0;
    // The dispatcher intent succeeds; the action-boundary intent fails.
    f.context.audit.record = async event => { if (event.phase === 'intent' && ++intents === 2) throw new Error('audit down sentinel'); };
    const result = await dispatch(f.registry, 'quiz.fill', f.target, f.context);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(f.calls).toEqual([]);
  });

  it.each(['fill', 'submit'] as const)('%s outcome audit failure after the external action reports UNCERTAIN without retry', async kind => {
    const f = await setup({ level: 4, autoSubmit: true });
    const filled = kind === 'submit' ? await fill(f) : undefined;
    f.context.audit.record = async event => { if (event.command === `quiz.${kind}` && event.phase === 'outcome') throw new Error('audit down'); };
    const result = await dispatch(f.registry, `quiz.${kind}`, kind === 'fill' ? f.target : filled, f.context);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
    expect(f.calls.filter(c => c === kind)).toHaveLength(1);
  });

  it.each(['partial', 'throw'] as const)('reports %s external fill state as uncertain, records no filled revision and never retries', async mode => {
    const f = await setup({ level: 3 });
    (f.fill.fill as ReturnType<typeof vi.fn>).mockImplementationOnce(async target => {
      f.calls.push('fill');
      if (mode === 'throw') throw new Error('browser crashed sentinel');
      return { status: 'partial', target, retrySafe: false };
    });
    const result = await dispatch(f.registry, 'quiz.fill', f.target, f.context);
    expect(result).toMatchObject({ ok: true, data: { status: mode === 'partial' ? 'partial' : 'uncertain', retrySafe: false } });
    expect(JSON.stringify([result, f.context.events])).not.toContain('sentinel');
    expect(f.calls).toEqual(['fill']);
    expect(await f.filled.get('quiz-a')).toBeUndefined();
    expect(f.context.events.some(e => e.command === 'quiz.fill' && e.phase === 'outcome' && e.code === 'UNCERTAIN')).toBe(true);
  });

  it('reports UNCERTAIN when the filled state cannot be persisted after the fill', async () => {
    const f = await setup({ level: 3 });
    vi.spyOn(f.filled, 'put').mockRejectedValueOnce(new Error('store down'));
    expect(await dispatch(f.registry, 'quiz.fill', f.target, f.context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } });
    expect(f.calls).toEqual(['fill']);
  });
});
