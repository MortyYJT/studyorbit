import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuizFiles } from '../../src/quiz/files.js';
import { AuditTrail } from '../../src/quiz/audit.js';
import { recordOwnerAction, proposeQuiz, FileEvidence } from '../../src/quiz/proposals.js';
import { hash } from '../../src/quiz/citations.js';
import { parseQuizCLI } from '../../src/quiz/cli.js';
const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
const binding = { assessmentId: 'synthetic-assessment', course: '7', lesson: '11', category: 'assignment' };
const policy = { version: 1, course: '7', status: 'owner-attested', attestation: 'Synthetic permission POLICY-SENTINEL', date: '2026-10-12', cap: 3 };
const grant = { version: 1, binding, level: 3, date: '2026-10-12' };
const q = 'ed:7:11:21:31';
const data = { assessmentRef: 'ed:7:11', questions: [{ ref: q, supported: true, type: 'text', prompt: 'What is parity?' }], sources: [{ sourceItemId: q, text: 'What is parity?', locator: 'question:31' }],
  coverage: { complete: true, scope: 'assessment', total: 1, supported: 1, unsupported: 0 } };
const answer = { questionRef: q, answer: 'Even.', rationale: 'My calculation.', citations: [{ sourceItemId: q, quote: 'What is parity?', locator: 'question:31' }],
  statements: [{ field: 'answer', text: 'Even.', kind: 'reasoning' }, { field: 'rationale', text: 'My calculation.', kind: 'reasoning' }] };
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'quiz-proposal-'))); directories.push(root); const files = new QuizFiles(root);
  const audit = new AuditTrail(line => files.append('audit', line));
  const dependencies = { files, audit, isTTY: true, confirm: vi.fn(async () => true) };
  const evidence = new FileEvidence(files); await evidence.saveRead(data);
  const input = { version: 1, binding, sourceRevision: hash(data), answers: [answer] };
  return { root, files, dependencies, input, evidence };
}
async function authorize(f: Awaited<ReturnType<typeof setup>>) {
  expect(await recordOwnerAction('policy', policy, f.dependencies)).toMatchObject({ ok: true });
  expect(await recordOwnerAction('grant', grant, f.dependencies)).toMatchObject({ ok: true });
}
it('owner recording requires explicit TTY confirmation, never implied by proposals', async () => {
  const f = await setup();
  expect(await recordOwnerAction('policy', policy, { ...f.dependencies, isTTY: false })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(f.dependencies.confirm).not.toHaveBeenCalled();
  expect(await recordOwnerAction('policy', policy, { ...f.dependencies, confirm: async () => false })).toMatchObject({ ok: false });
  expect(await proposeQuiz(f.input, f.dependencies)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await f.files.read('policy-7')).toBeUndefined();
  await authorize(f);
  expect(await recordOwnerAction('grant', { ...grant, level: 3, binding: { ...binding, category: 'exam' } }, f.dependencies)).toMatchObject({ ok: false });
});
it('accepts private versioned proposals with exact binding and prompt-only limitation', async () => {
  const f = await setup(); await authorize(f);
  const result = await proposeQuiz(f.input, f.dependencies);
  expect(result).toMatchObject({ ok: true, data: { revision: expect.any(String), evidence: ['prompt-only'] } });
  if (!result.ok) throw Error('expected success');
  const saved = await f.files.read(`proposal-${hash(binding.assessmentId)}`);
  expect(saved).toMatchObject({ version: 1, binding, answers: [{ evidence: 'prompt-only', limitation: expect.any(String) }], revision: (result.data as { revision: string }).revision });
  expect((await stat(join(f.root, 'quiz', `proposal-${hash(binding.assessmentId)}.json`))).mode & 0o777).toBe(0o600);
  expect(await proposeQuiz(f.input, f.dependencies)).toMatchObject({ ok: true, data: { revision: expect.not.stringMatching((result.data as { revision: string }).revision) } });
  expect(await f.files.read(`revision-${(result.data as { revision: string }).revision}`)).toEqual(saved);
});
it('citation rejection is safely ledgered and preserves accepted revision', async () => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const before = await f.files.read(`proposal-${hash(binding.assessmentId)}`);
  for (const citations of [[{ ...answer.citations[0], quote: 'ANSWER-SENTINEL' }], [{ ...answer.citations[0], sourceItemId: 'fabricated' }]]) {
    expect(await proposeQuiz({ ...f.input, answers: [{ ...answer, citations }] }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
    expect(await f.files.read(`proposal-${hash(binding.assessmentId)}`)).toEqual(before);
  }
  const ledger = await readFile(join(f.root, 'quiz', 'runs.jsonl'), 'utf8');
  expect(ledger).toContain('CITATION_MISMATCH'); expect(ledger).not.toMatch(/ANSWER-SENTINEL|What is parity|My calculation/);
  const audit = await readFile(join(f.root, 'quiz', 'audit.jsonl'), 'utf8');
  expect(audit).not.toMatch(/POLICY-SENTINEL|What is parity|My calculation/);
});
it('material evidence resolves private trusted text and requires separate material citation', async () => {
  const f = await setup(); await authorize(f);
  const material = { version: 1, course: '7', redacted: true, source: { sourceItemId: 'synthetic-material', kind: 'material', text: 'Parity is even or odd.', locator: 'page:2', page: 2 } };
  await f.files.write(`material-${hash('synthetic-material')}`, material);
  const a = { ...answer, rationale: material.source.text, statements: [answer.statements[0], { field: 'rationale', text: material.source.text, kind: 'material', sourceItemId: 'synthetic-material' }] };
  expect(await proposeQuiz({ ...f.input, answers: [a] }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect(await proposeQuiz({ ...f.input, answers: [{ ...a, citations: [...a.citations, { sourceItemId: 'synthetic-material', quote: material.source.text, locator: 'page:2' }] }] }, f.dependencies)).toMatchObject({ ok: true, data: { evidence: ['course-material'] } });
});
it('malformed/wrong assessment/question/source revision never replace accepted proposal', async () => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const before = await f.files.read(`proposal-${hash(binding.assessmentId)}`);
  for (const input of [{ ...f.input, binding: { ...binding, assessmentId: '../outside' } }, { ...f.input, binding: { ...binding, lesson: '12' } },
    { ...f.input, sourceRevision: 'a'.repeat(64) }, { ...f.input, answers: [{ ...answer, questionRef: 'ed:7:11:21:99' }] }, { ...f.input, sources: [{ text: 'fabricated' }] }]) {
    expect(await proposeQuiz(input, f.dependencies)).toMatchObject({ ok: false }); expect(await f.files.read(`proposal-${hash(binding.assessmentId)}`)).toEqual(before);
  }
});
it('audit failure blocks proposal writes and owner records before mutation', async () => {
  const f = await setup(); await authorize(f);
  const audit = new AuditTrail(async () => { throw Error('SECRET-SENTINEL'); });
  expect(await proposeQuiz(f.input, { ...f.dependencies, audit })).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(await f.files.read(`proposal-${hash(binding.assessmentId)}`)).toBeUndefined();
  expect(await recordOwnerAction('policy', { ...policy, course: '8' }, { ...f.dependencies, audit })).toMatchObject({ ok: false });
  expect(await f.files.read('policy-8')).toBeUndefined();
});
it('propose/policy/grant CLI emit one envelope from private JSON input', async () => {
  const f = await setup(); const stdout = vi.fn(); const deps = { ...f.dependencies, stdout };
  const inputPath = join(f.root, 'input.json');
  await f.files.write('input', {});
  const { writeFile } = await import('node:fs/promises');
  for (const [command, value] of [['policy', policy], ['grant', grant], ['propose', f.input]] as const) {
    await writeFile(inputPath, JSON.stringify(value), { mode: 0o600 }); stdout.mockClear();
    await parseQuizCLI(['quiz', command, '--input', inputPath], deps);
    expect(stdout).toHaveBeenCalledOnce(); expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ ok: true, command: `quiz.${command}` });
  }
  stdout.mockClear(); await parseQuizCLI(['quiz', 'propose', '--input', join(f.root, 'missing-SECRET-SENTINEL')], deps);
  expect(stdout).toHaveBeenCalledOnce(); expect(stdout.mock.calls[0][0]).not.toContain('SECRET-SENTINEL');
});
it('CLI input failures are audited with no private filename or JSON contents', async () => {
  const f = await setup(); const stdout = vi.fn();
  await parseQuizCLI(['quiz', 'propose', '--input', join(f.root, 'missing-INPUT-SENTINEL')], { ...f.dependencies, stdout });
  const audit = await readFile(join(f.root, 'quiz', 'audit.jsonl'), 'utf8');
  expect(audit).toContain('INVALID_INPUT'); expect(audit).not.toContain('INPUT-SENTINEL');
  const result = JSON.parse(stdout.mock.calls[0][0]);
  expect(JSON.parse(audit.trim().split('\n').at(-1)!)).toMatchObject({ runId: result.meta.runId, operation: 'proposal', code: 'INVALID_INPUT' });
});
it.each(['answer', 'rationale'] as const)('material citation denial in %s preserves revision and safe ledger', async field => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const before = await f.files.read(`proposal-${hash(binding.assessmentId)}`);
  const material = { version: 1, course: '7', redacted: true, source: { sourceItemId: 'synthetic-material', kind: 'material', text: 'Synthetic material statement.', locator: 'page:2', page: 2 } };
  await f.files.write(`material-${hash(material.source.sourceItemId)}`, material);
  const a = { ...answer, [field]: material.source.text, statements: answer.statements.map(s => s.field === field
    ? { field, text: material.source.text, kind: 'material', sourceItemId: material.source.sourceItemId } : s) };
  expect(await proposeQuiz({ ...f.input, answers: [a] }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect(await f.files.read(`proposal-${hash(binding.assessmentId)}`)).toEqual(before);
  expect(await readFile(join(f.root, 'quiz', 'runs.jsonl'), 'utf8')).not.toContain(material.source.text);
});
it('atomic pointer-write failure preserves the previous accepted revision', async () => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const name = `proposal-${hash(binding.assessmentId)}`; const before = await f.files.read(name);
  const write = f.files.write.bind(f.files);
  vi.spyOn(f.files, 'write').mockImplementation(async (key, value) => { if (key === name) throw Error('PRIVATE-SENTINEL'); await write(key, value); });
  expect(await proposeQuiz(f.input, f.dependencies)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(await f.files.read(name)).toEqual(before);
});
it('undeclared copied local material cannot be accepted as prompt-only reasoning', async () => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const before = await f.files.read(`proposal-${hash(binding.assessmentId)}`);
  const material = { version: 1, course: '7', redacted: true, source: { sourceItemId: 'synthetic-material', kind: 'material', text: 'Parity is exactly even or odd.', locator: 'page:2', page: 2 } };
  await f.files.write(`material-${hash(material.source.sourceItemId)}`, material);
  const a = { ...answer, answer: material.source.text, statements: [{ field: 'answer', text: material.source.text, kind: 'reasoning' }, answer.statements[1]] };
  expect(await proposeQuiz({ ...f.input, answers: [a] }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect(await f.files.read(`proposal-${hash(binding.assessmentId)}`)).toEqual(before);
});
it.each(['policy', 'grant', 'prerequisites', 'propose'] as const)('audits missing CLI input for %s under its actual command', async command => {
  const f = await setup(); const stdout = vi.fn();
  await parseQuizCLI(['quiz', command], { ...f.dependencies, stdout });
  expect(stdout).toHaveBeenCalledOnce();
  const result = JSON.parse(stdout.mock.calls[0][0]);
  expect(result).toMatchObject({ command: `quiz.${command}`, ok: false, error: { code: 'INVALID_INPUT' } });
  expect(JSON.parse((await readFile(join(f.root, 'quiz', 'audit.jsonl'), 'utf8')).trim())).toMatchObject({ operation: command === 'propose' ? 'proposal' : command, runId: result.meta.runId, code: 'INVALID_INPUT' });
});
it('post-write ledger failure returns a clean failure envelope and reports uncertain local state', async () => {
  const f = await setup(); await authorize(f);
  const append = f.files.append.bind(f.files);
  vi.spyOn(f.files, 'append').mockImplementation(async (name, line) => { if (name === 'runs') throw Error('SECRET-SENTINEL'); await append(name, line); });
  const result = await proposeQuiz(f.input, f.dependencies);
  expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: expect.stringContaining('inspect local state') } });
  expect(result).not.toHaveProperty('data'); expect(JSON.stringify(result)).not.toContain('SECRET-SENTINEL');
  expect(await f.files.read(`proposal-${hash(binding.assessmentId)}`)).toBeDefined();
});

it.each(['answer', 'rationale'] as const)('normalized undeclared material in %s preserves the accepted revision and safe ledger', async field => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const name = `proposal-${hash(binding.assessmentId)}`;
  const before = await f.files.read(name);
  const material = { version: 1, course: '7', redacted: true, source: { sourceItemId: 'synthetic-material', kind: 'material', text: 'Parity is even or odd.', locator: 'page:2', page: 2 } };
  await f.files.write(`material-${hash(material.source.sourceItemId)}`, material);
  for (const text of ['Parity is even or odd', 'PARITY: is\n even / or odd!', 'Even or odd is the parity.', 'Parity can be even.']) {
    const a = { ...answer, [field]: text, statements: answer.statements.map(s => s.field === field ? { ...s, text } : s) };
    expect(await proposeQuiz({ ...f.input, answers: [a] }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
    expect(await f.files.read(name)).toEqual(before);
  }
  const ledger = await readFile(join(f.root, 'quiz', 'runs.jsonl'), 'utf8');
  expect(ledger).toContain('CITATION_MISMATCH'); expect(ledger).not.toMatch(/Parity|PARITY|even or odd/);
});

it('symbolic material copied as reasoning preserves the accepted revision on rejection', async () => {
  const f = await setup(); await authorize(f); await proposeQuiz(f.input, f.dependencies);
  const name = `proposal-${hash(binding.assessmentId)}`; const before = await f.files.read(name);
  const source = { sourceItemId: 'synthetic-symbols', kind: 'material', text: '⊤ ∨ ⊥ = ⊤.', locator: 'page:2', page: 2 };
  await f.files.write(`material-${hash(source.sourceItemId)}`, { version: 1, course: '7', redacted: true, source });
  const a = { ...answer, answer: source.text, statements: [{ field: 'answer', text: source.text, kind: 'reasoning' }, answer.statements[1]] };
  expect(await proposeQuiz({ ...f.input, answers: [a] }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
  expect(await f.files.read(name)).toEqual(before);
});
