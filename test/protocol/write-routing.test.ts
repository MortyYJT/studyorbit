import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizFiles } from '../../src/quiz/files.js';
import { FileEvidence, recordOwnerAction } from '../../src/quiz/proposals.js';
import { hash } from '../../src/quiz/citations.js';
import { SharedAuthorization, Q1AuthorizationStore, IdentityMap } from '../../src/protocol/authorization.js';
import { DurableAudit } from '../../src/protocol/audit.js';
import { ComposedServices, ComposedEvidence, Q1QuizServices, Q1ProposalEvidence, reviewBoundActionEvidence } from '../../src/protocol/writes.js';
import { GatedQuizActions, Q1ReviewPreflight, SingleUseConfirmations, InMemoryFilledStore } from '../../src/protocol/actions.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { protectRead } from '../../src/protocol/read-privacy.js';
import { createFakeContext, examples } from '../../src/protocol/fakes.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('deferred dispatcher P3 fixes', () => {
  it('reports UNCERTAIN, not INTERNAL, when output or privacy validation fails after a successful write', async () => {
    const context = createFakeContext(); const write = vi.spyOn(context.services, 'write').mockResolvedValue({ invalid: true } as never);
    expect(await dispatch(createRegistry(), 'revision.write', examples['revision.write'].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
    expect(write).toHaveBeenCalledOnce();
    const other = createFakeContext(); const calls = vi.spyOn(other.services, 'write');
    other.privacy.protect = async () => { throw new Error('privacy sentinel'); };
    const result = await dispatch(createRegistry(), 'practice.write', examples['practice.write'].input, other);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } });
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(calls).toHaveBeenCalledOnce();
    expect(other.events.at(-1)).toMatchObject({ phase: 'outcome', code: 'UNCERTAIN' });
  });

  it('keeps INTERNAL for reads whose output fails validation', async () => {
    const context = createFakeContext();
    context.repository.read = vi.fn(async () => ({ invalid: true })) as typeof context.repository.read;
    expect(await dispatch(createRegistry(), 'courses.list', examples['courses.list'].input, context)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });

  it.each([['quiz.policy', 'policy.record'], ['quiz.grant', 'grant.record']] as const)('%s checks the receipt against the trusted legacy target', async (alias, canonical) => {
    const context = createFakeContext({ owner: true });
    const write = vi.fn(async () => ({ ...examples[canonical].output, courseId: 'other-course' }));
    context.services.write = write as typeof context.services.write;
    expect(await dispatch(createRegistry(), alias, examples[alias].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } });
    expect(write).toHaveBeenCalledOnce();
    if (alias === 'quiz.grant') {
      context.services.write = vi.fn(async () => ({ ...examples['grant.record'].output, assessmentId: 'other-assessment' })) as typeof context.services.write;
      expect(await dispatch(createRegistry(), alias, examples[alias].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } });
    }
    // Without a trusted legacy translation the alias is denied before any write.
    const untranslated = createFakeContext({ owner: true }); const denied = vi.fn();
    untranslated.services = { write: denied as never };
    expect(await dispatch(createRegistry(), alias, examples[alias].input, untranslated)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(denied).not.toHaveBeenCalled();
  });
});

const binding = { assessmentId: 'legacy-quiz', course: '7', lesson: '11', category: 'assignment' as const };
const q = 'ed:7:11:21:31'; const q2 = 'ed:7:11:21:32';
const data = { assessmentRef: 'ed:7:11', questions: [{ ref: q, supported: true, type: 'text', prompt: 'Synthetic question?' },
  { ref: q2, supported: true, type: 'text', prompt: 'Second synthetic question?' }],
  sources: [{ sourceItemId: q, text: 'Synthetic question?', locator: 'question:31' }, { sourceItemId: q2, text: 'Second synthetic question?', locator: 'question:32' }],
  coverage: { complete: true, scope: 'assessment', total: 2, supported: 2, unsupported: 0 } };
const answer = (ref = q, quote = 'Synthetic question?', locator = 'question:31', cited = ref) => ({ questionRef: ref, answer: 'Synthetic answer.', rationale: 'Own reasoning.',
  citations: [{ sourceItemId: cited, quote, locator }],
  statements: [{ field: 'answer', text: 'Synthetic answer.', kind: 'reasoning' }, { field: 'rationale', text: 'Own reasoning.', kind: 'reasoning' }] });
const map = { courses: [{ courseId: 'course-a', edCourse: '7' }], assessments: [{ assessmentId: 'quiz-a', courseId: 'course-a', binding }] };
async function unified(level = 2) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'routing-'))); roots.push(root);
  const files = new QuizFiles(root); const tty = { files, isTTY: true, confirm: async () => true };
  await recordOwnerAction('policy', { version: 1, course: '7', status: 'owner-attested', attestation: 'Synthetic permission', date: '2026-10-12', cap: 4 }, tty);
  await recordOwnerAction('grant', { version: 1, binding, level, date: '2026-10-12' }, tty);
  await new FileEvidence(files).saveRead(data);
  const identities = new IdentityMap(map); const audit = new DurableAudit(files);
  const authorization = new SharedAuthorization(new Q1AuthorizationStore(files, identities), audit);
  const decide = vi.fn(async () => 'approve' as const);
  const quiz = new Q1QuizServices({ files, isTTY: true, display: () => {}, decide });
  const submit = vi.fn(); const fill = vi.fn();
  const actions = new GatedQuizActions({ authorization, review: new Q1ReviewPreflight(files, identities), filled: new InMemoryFilledStore(),
    confirmations: new SingleUseConfirmations(), fill: { fill }, submit: { submit } });
  const context = createFakeContext({ owner: true });
  context.authorization = authorization; context.actions = actions;
  context.privacy = { protect: async (_command, value) => protectRead(value) };
  context.services = new ComposedServices({ 'policy.record': authorization.services, 'grant.record': authorization.services, 'quiz.propose': quiz, 'quiz.review': quiz });
  context.evidence = new ComposedEvidence({ 'quiz.propose': new Q1ProposalEvidence(files), 'quiz.fill': reviewBoundActionEvidence, 'quiz.submit': reviewBoundActionEvidence });
  return { files, tty, context, decide, fill, submit, registry: createRegistry() };
}
const proposal = (answers = [answer()], sourceRevision = hash(data)) => ({ version: 1, binding, sourceRevision, answers });

describe('8.2 quiz proposals and review through unified services', () => {
  it('records a Q1-compatible proposal once and reviews it through the same services', async () => {
    const u = await unified();
    const result = await dispatch(u.registry, 'quiz.propose', proposal(), u.context);
    expect(result).toMatchObject({ ok: true, data: { assessmentRef: 'ed:7:11', sourceRevision: hash(data), evidence: ['prompt-only'] } });
    if (!result.ok) throw new Error('expected proposal');
    const { revision } = result.data as { revision: string };
    const record = await u.files.read(`proposal-${hash(binding.assessmentId)}`);
    expect(record).toMatchObject({ revision, binding, policyRef: hash(await u.files.read('policy-7')), grantRef: hash(await u.files.read(`grant-${hash(binding.assessmentId)}`)) });
    expect(JSON.stringify(record)).not.toMatch(/submitted|filled/);
    const page = { course: '7', lesson: '11', pageId: 'synthetic-page', attemptId: '41' };
    expect(await dispatch(u.registry, 'quiz.review', { assessmentId: binding.assessmentId, revision, page }, u.context)).toMatchObject({ ok: true, data: { status: 'approved', revision } });
    expect(u.decide).toHaveBeenCalledOnce();
    // A saved and approved proposal is never treated as filled or submitted state.
    expect(await dispatch(u.registry, 'quiz.submit', { assessmentId: 'quiz-a', revision, sourceRevision: hash(data), page,
      policyRef: hash(await u.files.read('policy-7')), grantRef: hash(await u.files.read(`grant-${hash(binding.assessmentId)}`)),
      filledRevision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, u.context)).toMatchObject({ ok: false });
    expect(u.submit).not.toHaveBeenCalled(); expect(u.fill).not.toHaveBeenCalled();
  });

  it('preflights exact own-question/material coverage and source bindings before the Q1 handler writes', async () => {
    const u = await unified();
    for (const [input, code] of [
      [proposal([answer(q, 'Second synthetic question?', 'question:32', q2)]), 'CITATION_MISMATCH'],
      [proposal([answer(q, 'Invented quote', 'question:31')]), 'CITATION_MISMATCH'],
      [proposal([answer(q, 'Synthetic', 'page:1', 'material-other-course')]), 'CITATION_MISMATCH'],
      [proposal([answer()], 'f'.repeat(64)), 'CONFLICT'],
    ] as const) {
      const before = u.context.events.length;
      expect(await dispatch(u.registry, 'quiz.propose', input, u.context), JSON.stringify(input)).toMatchObject({ ok: false, error: { code } });
      expect(u.context.events.slice(before).map(e => e.phase)).toEqual(['denial']);
    }
    expect(await u.files.read(`proposal-${hash(binding.assessmentId)}`)).toBeUndefined();
  });

  it('denies proposals without an L2 grant and routes legacy owner recording through the identity map', async () => {
    const u = await unified(1);
    expect(await dispatch(u.registry, 'quiz.propose', proposal(), u.context)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await dispatch(u.registry, 'quiz.grant', { version: 1, binding, level: 2, date: '2026-10-12' }, u.context)).toMatchObject({ ok: true, data: { recorded: 'grant' } });
    expect(await dispatch(u.registry, 'quiz.propose', proposal(), u.context)).toMatchObject({ ok: true });
    expect(await dispatch(u.registry, 'quiz.grant', { version: 1, binding: { ...binding, lesson: '12' }, level: 2, date: '2026-10-12' }, u.context)).toMatchObject({ ok: false });
  });

  it('refuses unrouted writes and evidence instead of accepting them', async () => {
    const u = await unified();
    expect(await dispatch(u.registry, 'revision.write', examples['revision.write'].input, u.context)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  });
});
