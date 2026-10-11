import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { QuizFiles } from '../../src/quiz/files.js';
import { AuditTrail } from '../../src/quiz/audit.js';
import { FileEvidence, proposeQuiz, recordOwnerAction } from '../../src/quiz/proposals.js';
import { hash } from '../../src/quiz/citations.js';
import { reviewQuiz, reviewedRevisionPreflight, withReviewedRevision, terminalReviewDecision } from '../../src/quiz/review.js';
import { parseQuizCLI } from '../../src/quiz/cli.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const binding = { assessmentId: 'synthetic-assessment', course: '7', lesson: '11', category: 'assignment' };
const page = { course: '7', lesson: '11', pageId: 'synthetic-page', attemptId: '41' };
const q = 'ed:7:11:21:31';
const q2 = 'ed:7:11:21:32';
const unsupported = 'ed:7:11:21:33';
const data = { assessmentRef: 'ed:7:11', questions: [
  { ref: q, supported: true, type: 'text', prompt: 'Synthetic first question?' },
  { ref: q2, supported: true, type: 'multiple-choice', prompt: 'Synthetic second question?', options: [{ id: '1', text: 'Alpha' }, { id: '2', text: 'Beta' }] },
  { ref: unsupported, supported: false, type: 'unsupported' },
], sources: [{ sourceItemId: q, text: 'Synthetic first question?', locator: 'question:31' }, { sourceItemId: q2, text: 'Synthetic second question?\n1: Alpha\n2: Beta', locator: 'question:32' }],
coverage: { complete: false, scope: 'assessment', total: 3, supported: 2, unsupported: 1 } };
function answer(ref: string, prompt: string, value: string) { return { questionRef: ref, answer: value, rationale: 'My calculation.',
  citations: [{ sourceItemId: ref, quote: prompt, locator: `question:${ref.split(':').at(-1)}` }],
  statements: [{ field: 'answer', text: value, kind: 'reasoning' }, { field: 'rationale', text: 'My calculation.', kind: 'reasoning' }] }; }
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'quiz-review-'))); roots.push(root);
  const files = new QuizFiles(root); const owner = { files, isTTY: true, confirm: async () => true };
  await recordOwnerAction('policy', { version: 1, course: '7', status: 'owner-attested', attestation: 'Synthetic permission', date: '2026-10-12', cap: 3 }, owner);
  await recordOwnerAction('grant', { version: 1, binding, level: 3, date: '2026-10-12' }, owner);
  const evidence = new FileEvidence(files); await evidence.saveRead(data);
  const input = { version: 1, binding, sourceRevision: hash(data), answers: [answer(q, 'Synthetic first question?', 'First answer.'), answer(q2, 'Synthetic second question?', '1')] };
  const result = await proposeQuiz(input, owner); if (!result.ok) throw Error('synthetic proposal failed');
  const revision = (result.data as { revision: string }).revision;
  const display = vi.fn(); const decide = vi.fn(async () => 'reject' as const);
  return { root, files, input, evidence, request: { assessmentId: binding.assessmentId, revision, page }, dependencies: { files, isTTY: true, display, decide }, display, decide };
}

it('3.1 displays all questions, answers, rationale, citation quotes/locators and target on the terminal only', async () => {
  const f = await setup(); const stdout = vi.fn();
  await parseQuizCLI(['quiz', 'review', '--assessment', binding.assessmentId, '--revision', f.request.revision, '--page', page.pageId, '--attempt', page.attemptId], { ...f.dependencies, stdout });
  const shown = f.display.mock.calls.flat().join('\n');
  for (const value of ['synthetic-assessment', 'ed:7:11', f.request.revision, page.pageId, page.attemptId, q, q2, unsupported,
    'Synthetic first question?', 'Synthetic second question?', 'Alpha', 'Beta', 'First answer.', 'My calculation.', 'question:31', 'question:32', 'prompt-only', 'unsupported', 'not correctness']) expect(shown).toContain(value);
  expect(stdout).toHaveBeenCalledOnce();
  expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ command: 'quiz.review', ok: true, data: { status: 'rejected' } });
  expect(stdout.mock.calls[0][0]).not.toMatch(/First answer|My calculation|Synthetic first question/);
  expect(f.decide).toHaveBeenCalledOnce();
});
it('3.1 requires a specific current revision and displays nothing for a missing revision', async () => {
  const f = await setup();
  expect(await reviewQuiz({ ...f.request, revision: '00000000-0000-4000-8000-000000000000' }, f.dependencies)).toMatchObject({ ok: false });
  expect(f.display).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
});

it('3.2 explicit approval persists exact proposal/source/page hashes privately without changing policy/grant', async () => {
  const f = await setup(); const before = [await f.files.read('policy-7'), await f.files.read(`grant-${hash(binding.assessmentId)}`)];
  expect(await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' })).toMatchObject({ ok: true, data: { status: 'approved', revision: f.request.revision } });
  const record = await f.files.read(`proposal-${hash(binding.assessmentId)}`);
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).toMatchObject({ status: 'approved', revision: f.request.revision, proposalHash: hash(record), sourceRevision: hash(data), page });
  expect([await f.files.read('policy-7'), await f.files.read(`grant-${hash(binding.assessmentId)}`)]).toEqual(before);
  const audit = await readFile(join(f.root, 'quiz', 'audit.jsonl'), 'utf8');
  const events = audit.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.operation === 'review');
  expect(events).toMatchObject([{ phase: 'intent' }, { phase: 'intent', reviewStatus: 'approved' }, { phase: 'outcome', revision: f.request.revision, code: 'OK' }]);
  expect(audit).not.toMatch(/First answer|My calculation|Synthetic first question|Synthetic permission|synthetic-page/);
});
it.each(['reject', 'cancel'] as const)('3.2 %s blocks approval, including a previous approval', async decision => {
  const f = await setup(); await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' });
  expect(await reviewQuiz(f.request, { ...f.dependencies, decide: async () => decision })).toMatchObject({ ok: true, data: { status: decision === 'reject' ? 'rejected' : 'cancelled' } });
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).not.toMatchObject({ status: 'approved' });
});
it('3.2 timeout aborts a stuck terminal prompt and never approves a late response', async () => {
  const f = await setup(); let signal: AbortSignal | undefined; let resolve!: (value: 'approve') => void;
  expect(await reviewQuiz(f.request, { ...f.dependencies, timeoutMs: 10, decide: async s => { signal = s; return new Promise(r => { resolve = r; }); } })).toMatchObject({ ok: true, data: { status: 'timed-out' } });
  expect(signal?.aborted).toBe(true); resolve('approve');
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).not.toMatchObject({ status: 'approved' });
});
it('3.2 cancellation signal stops waiting and non-TTY cannot display or ask', async () => {
  const f = await setup(); const controller = new AbortController();
  expect(await reviewQuiz(f.request, { ...f.dependencies, signal: controller.signal, decide: async () => { controller.abort(); return 'approve'; } })).toMatchObject({ ok: true, data: { status: 'cancelled' } });
  f.display.mockClear();
  expect(await reviewQuiz(f.request, { ...f.dependencies, isTTY: false })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(f.display).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
});
it.each(['intent', 'outcome'] as const)('3.2 %s audit failure leaves no usable approval and sanitized failure', async phase => {
  const f = await setup();
  const audit = new AuditTrail(async line => { if (JSON.parse(line).phase === phase) throw Error('SECRET-SENTINEL'); });
  const result = await reviewQuiz(f.request, { ...f.dependencies, audit, decide: async () => 'approve' });
  expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).not.toMatchObject({ status: 'approved' });
  expect(JSON.stringify(result)).not.toContain('SECRET-SENTINEL');
  if (phase === 'intent') expect(f.display).not.toHaveBeenCalled();
});
it('3.2 invalid input, prompt failure and missing CLI arguments fail safely with a single review envelope', async () => {
  const f = await setup(); const stdout = vi.fn();
  await parseQuizCLI(['quiz', 'review'], { ...f.dependencies, stdout });
  expect(stdout).toHaveBeenCalledOnce(); expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ command: 'quiz.review', ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await reviewQuiz(f.request, { ...f.dependencies, decide: async () => { throw Error('PRIVATE-SENTINEL'); } })).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).not.toMatchObject({ status: 'approved' });
});

it('3.3 preflight returns only the exact reviewed state and requires explicit approval', async () => {
  const f = await setup();
  await expect(reviewedRevisionPreflight(f.request, f.files)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' });
  expect(await reviewedRevisionPreflight(f.request, f.files)).toMatchObject({ record: { revision: f.request.revision, binding }, page, snapshot: { sourceRevision: hash(data) } });
});
it.each(['answer', 'rationale', 'citation', 'binding'] as const)('3.3 edited %s invalidates approval even if both proposal copies are edited', async field => {
  const f = await setup(); await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' });
  const name = `proposal-${hash(binding.assessmentId)}`;
  const record = await f.files.read(name) as { binding: typeof binding; answers: { answer: string; rationale: string; validatedCitations: { locator: string }[] }[] };
  if (field === 'citation') record.answers[0].validatedCitations[0].locator = 'question:99';
  else if (field === 'binding') record.binding.lesson = '99';
  else record.answers[0][field] = 'Edited synthetic text';
  await f.files.write(name, record); await f.files.write(`revision-${f.request.revision}`, record);
  await expect(reviewedRevisionPreflight(f.request, f.files)).rejects.toMatchObject({ code: 'CONFLICT' });
});
it.each(['question', 'options', 'question-id', 'slide-id', 'source'] as const)('3.3 changed %s identity invalidates approval', async kind => {
  const f = await setup(); await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' });
  const changed = structuredClone(data);
  if (kind === 'question') changed.questions[0].prompt = 'Changed prompt';
  if (kind === 'options') changed.questions[1].options![0].text = 'Changed option';
  if (kind === 'question-id' || kind === 'slide-id') {
    const ref = kind === 'question-id' ? 'ed:7:11:21:99' : 'ed:7:11:99:31';
    changed.questions[0].ref = ref; changed.sources[0].sourceItemId = ref; changed.sources[0].locator = `question:${ref.split(':').at(-1)}`;
  }
  if (kind === 'source') changed.sources[0].text = 'Changed trusted source';
  await f.evidence.saveRead(changed);
  await expect(reviewedRevisionPreflight(f.request, f.files)).rejects.toMatchObject({ code: 'CONFLICT' });
});
it.each(['page', 'attempt', 'missing-attempt', 'course', 'lesson'] as const)('3.3 changed %s target invalidates approval', async kind => {
  const f = await setup(); await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' });
  const changed: typeof page & { attemptId?: string } = { ...page };
  if (kind === 'page') changed.pageId = 'other-page';
  if (kind === 'attempt') changed.attemptId = '99';
  if (kind === 'missing-attempt') delete (changed as { attemptId?: string }).attemptId;
  if (kind === 'course') changed.course = '99';
  if (kind === 'lesson') changed.lesson = '99';
  await expect(reviewedRevisionPreflight({ ...f.request, page: changed }, f.files)).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('3.3 concurrent replacement during review, and a new revision after approval, invalidate old consent', async () => {
  const f = await setup();
  expect(await reviewQuiz(f.request, { ...f.dependencies, decide: async () => { expect(await proposeQuiz(f.input, { files: f.files })).toMatchObject({ ok: true }); return 'approve'; } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).not.toMatchObject({ status: 'approved' });
  const current = await f.files.read(`proposal-${hash(binding.assessmentId)}`) as { revision: string };
  const request = { ...f.request, revision: current.revision };
  await reviewQuiz(request, { ...f.dependencies, decide: async () => 'approve' });
  await proposeQuiz(f.input, { files: f.files });
  await expect(reviewedRevisionPreflight(request, f.files)).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('3.3 material text/locator/page changes invalidate the exact source hash', async () => {
  const f = await setup();
  const source = { sourceItemId: 'synthetic-material', kind: 'material', text: 'Unrelated zebra evidence.', locator: 'page:2', page: 2 };
  const name = `material-${hash(source.sourceItemId)}`;
  await f.files.write(name, { version: 1, course: '7', redacted: true, source });
  const proposed = await proposeQuiz(f.input, { files: f.files }); if (!proposed.ok) throw Error('synthetic proposal failed');
  const request = { ...f.request, revision: (proposed.data as { revision: string }).revision };
  for (const changed of [{ ...source, text: 'New material text.' }, { ...source, locator: 'page:3', page: 3 }]) {
    await f.files.write(name, { version: 1, course: '7', redacted: true, source });
    await reviewQuiz(request, { ...f.dependencies, decide: async () => 'approve' });
    await f.files.write(name, { version: 1, course: '7', redacted: true, source: changed });
    await expect(reviewedRevisionPreflight(request, f.files)).rejects.toMatchObject({ code: 'CONFLICT' });
  }
});
it('3.3 reusable guard holds the local mutation lock through the downstream action and never calls it on stale state', async () => {
  const f = await setup(); await reviewQuiz(f.request, { ...f.dependencies, decide: async () => 'approve' });
  const action = vi.fn(async () => {
    await expect(f.files.exclusive(async () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await proposeQuiz(f.input, { files: f.files })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    return 'guarded';
  });
  expect(await withReviewedRevision(f.request, action, f.files)).toBe('guarded');
  expect(action).toHaveBeenCalledOnce();
  await expect(withReviewedRevision({ ...f.request, page: { ...page, attemptId: '99' } }, action, f.files)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(action).toHaveBeenCalledOnce(); await f.files.exclusive(async () => {});
});

it.each(['exact', 'yes', 'wrong-revision', 'reject', 'ctrl-c', 'eof', 'eof-phrase', 'abort'] as const)('3.2 fake terminal input %s requires the exact entered approval phrase and cleans listeners', async kind => {
  const input = new PassThrough(); const output = new PassThrough(); const controller = new AbortController();
  const revision = '00000000-0000-4000-8000-000000000000'; const digest = 'a'.repeat(64);
  const pending = terminalReviewDecision(revision, digest, controller.signal, input, output);
  const expected = `APPROVE ${revision} ${digest}`;
  if (kind === 'abort') controller.abort();
  else if (kind === 'eof') input.end();
  else if (kind === 'eof-phrase') input.end(expected);
  else input.write(kind === 'exact' ? expected + '\n' : kind === 'yes' ? 'yes\n' : kind === 'wrong-revision' ? `APPROVE other ${digest}\n` : kind === 'reject' ? 'REJECT\n' : '\x03');
  expect(await pending).toBe(kind === 'exact' ? 'approve' : kind === 'reject' ? 'reject' : 'cancel');
  expect(input.listenerCount('keypress')).toBe(0); expect(input.listenerCount('end')).toBe(0); expect(input.listenerCount('error')).toBe(0);
  input.destroy(); output.destroy();
});
it('3.2 terminal controls in a proposed answer cannot erase the visible review', async () => {
  const f = await setup(); const answer = structuredClone(f.input.answers[0]);
  answer.answer = '\x1b[2J\rHidden\u202e'; answer.statements[0].text = answer.answer;
  const proposed = await proposeQuiz({ ...f.input, answers: [answer] }, { files: f.files }); if (!proposed.ok) throw Error('synthetic proposal failed');
  await reviewQuiz({ ...f.request, revision: (proposed.data as { revision: string }).revision }, f.dependencies);
  const shown = f.display.mock.calls.flat().join('\n');
  expect(shown).toContain('\\u001b[2J\\rHidden\\u202e'); expect(shown).not.toContain('\x1b');
  expect(shown).toContain('Missing proposed answer');
});
it('3.2 failed final approval activation leaves pending state rather than a usable approval', async () => {
  const f = await setup(); const write = f.files.write.bind(f.files);
  const events: Record<string, unknown>[] = [];
  const audit = new AuditTrail(async line => { events.push(JSON.parse(line)); });
  vi.spyOn(f.files, 'write').mockImplementation(async (name, value) => {
    if (name === `review-${hash(binding.assessmentId)}` && (value as { status?: string }).status === 'approved') throw Error('SECRET-SENTINEL');
    await write(name, value);
  });
  expect(await reviewQuiz(f.request, { ...f.dependencies, audit, decide: async () => 'approve' })).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  await expect(reviewedRevisionPreflight(f.request, f.files)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(events.some(event => event.phase === 'outcome' && event.code === 'OK' && event.reviewStatus === 'approved')).toBe(false);
  expect(events.at(-1)).toMatchObject({ phase: 'outcome', code: 'INTERNAL' });
  expect(events.at(-1)).not.toHaveProperty('reviewStatus', 'approved');
});
it('3.4 review cancellation during confirmation intent auditing cannot activate approval', async () => {
  const f = await setup(); const controller = new AbortController();
  const audit = new AuditTrail(async line => { const event = JSON.parse(line); if (event.phase === 'intent' && event.reviewStatus === 'approved') controller.abort(); });
  expect(await reviewQuiz(f.request, { ...f.dependencies, signal: controller.signal, audit, decide: async () => 'approve' })).toMatchObject({ ok: true, data: { status: 'cancelled' } });
  await expect(reviewedRevisionPreflight(f.request, f.files)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('3.2 cancellation during asynchronous approval storage leaves no usable approval', async () => {
  const f = await setup(); const controller = new AbortController(); const write = f.files.write.bind(f.files);
  vi.spyOn(f.files, 'write').mockImplementation(async (name, value, ...rest) => {
    if ((value as { status?: string }).status === 'approved') { await Promise.resolve(); controller.abort(); }
    await write(name, value, ...rest);
  });
  const events: Record<string, unknown>[] = [];
  const audit = new AuditTrail(async line => { events.push(JSON.parse(line)); });
  expect(await reviewQuiz(f.request, { ...f.dependencies, audit, signal: controller.signal, decide: async () => 'approve' })).toMatchObject({ ok: true, data: { status: 'cancelled' } });
  expect(controller.signal.aborted).toBe(true);
  await expect(reviewedRevisionPreflight(f.request, f.files)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(events.filter(event => event.phase === 'outcome')).toMatchObject([{ code: 'OK', reviewStatus: 'cancelled' }]);
});
it('3.2 success outcome is appended only after the exact approval is saved', async () => {
  const f = await setup(); const controller = new AbortController();
  const audit = new AuditTrail(async line => {
    const event = JSON.parse(line);
    if (event.phase === 'outcome' && event.reviewStatus === 'approved') {
      expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).toMatchObject({ status: 'approved', revision: f.request.revision, runId: event.runId });
      // Cancellation after durable activation does not retroactively cancel consent.
      controller.abort();
    }
  });
  expect(await reviewQuiz(f.request, { ...f.dependencies, audit, signal: controller.signal, decide: async () => 'approve' })).toMatchObject({ ok: true, data: { status: 'approved' } });
  expect(await reviewedRevisionPreflight(f.request, f.files)).toMatchObject({ record: { revision: f.request.revision } });
});
it.each(['approve', 'reject', 'cancel', 'timeout'] as const)('3.4 audit history records the safe %s review decision', async decision => {
  const f = await setup();
  const result = await reviewQuiz(f.request, { ...f.dependencies, timeoutMs: 10, decide: async () => decision === 'timeout' ? new Promise(() => {}) : decision });
  expect(result).toMatchObject({ ok: true });
  const events = (await readFile(join(f.root, 'quiz', 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events.at(-1)).toMatchObject({ operation: 'review', reviewStatus: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : decision === 'cancel' ? 'cancelled' : 'timed-out' });
});
it.each(['read', 'material'] as const)('3.4 %s removed/invalidated during the terminal wait returns CONFLICT', async kind => {
  const f = await setup();
  if (kind === 'material') {
    await f.files.write(`material-${hash('synthetic-material')}`, { version: 1, course: '7', redacted: true, source: { sourceItemId: 'synthetic-material', kind: 'material', text: 'Unrelated zebra evidence.', locator: 'page:2', page: 2 } });
    const result = await proposeQuiz(f.input, { files: f.files }); if (!result.ok) throw Error('synthetic proposal failed');
    f.request.revision = (result.data as { revision: string }).revision;
  }
  expect(await reviewQuiz(f.request, { ...f.dependencies, decide: async () => {
    await f.files.write(kind === 'read' ? `read-${hash('ed:7:11')}` : `material-${hash('synthetic-material')}`, {}); return 'approve';
  } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(await f.files.read(`review-${hash(binding.assessmentId)}`)).not.toMatchObject({ status: 'approved' });
});
