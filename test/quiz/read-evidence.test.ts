import { afterEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizFiles } from '../../src/quiz/files.js';
import { AuditTrail } from '../../src/quiz/audit.js';
import { FileEvidence, checkRealQuizPrerequisites, recordOwnerAction, proposeQuiz } from '../../src/quiz/proposals.js';
import { readQuiz } from '../../src/quiz/read/command.js';
import { selected, target } from './synthetic.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('read stores trusted normalized sources, emits sourceRevision and permits the cited local proposal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'quiz-read-evidence-'))); dirs.push(root); const files = new QuizFiles(root);
  const audit = new AuditTrail(line => files.append('audit', line));
  const owner = { files, audit, isTTY: true, confirm: async () => true };
  const binding = { assessmentId: 'synthetic', course: '7', lesson: '11', category: 'assignment' };
  await recordOwnerAction('policy', { version: 1, course: '7', status: 'owner-attested', cap: 3, date: '2026-10-12', attestation: 'Synthetic' }, owner);
  expect(await recordOwnerAction('prerequisites', { version: 1, binding, repositoryPrivate: true, verifiedAt: '2026-10-12T00:00:00Z' }, owner)).toMatchObject({ ok: true });
  await expect(checkRealQuizPrerequisites(target, files)).resolves.toBeUndefined();
  await expect(checkRealQuizPrerequisites({ course: '8', lesson: '11' }, files)).rejects.toThrow();
  await recordOwnerAction('grant', { version: 1, binding, date: '2026-10-12', level: 3 }, owner);
  const bodies = [{ lessons: [{ id: 11, kind: 'attempt' }] }, { lesson: { id: 11, slides: [{ id: 21 }] } }, { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt: 'Synthetic question?' }] } }];
  const result = await readQuiz(target, { files, audit, store: { load: async () => ({ status: 'valid', selection: selected }), save: async () => {} },
    openSession: async () => ({ transport: { read: async () => ({ kind: 'json', status: 200, body: bodies.shift() }) }, close: async () => {} }) });
  expect(result).toMatchObject({ ok: true, data: { sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  const snapshot = await new FileEvidence(files).read('ed:7:11');
  expect(result.ok && (result.data as { sourceRevision: string }).sourceRevision).toBe(snapshot.sourceRevision);
  const a = { questionRef: 'ed:7:11:21:31', answer: 'Synthetic answer.', rationale: 'Computed.', citations: [{ sourceItemId: 'ed:7:11:21:31', quote: 'Synthetic question?', locator: 'question:31' }],
    statements: [{ field: 'answer', text: 'Synthetic answer.', kind: 'reasoning' }, { field: 'rationale', text: 'Computed.', kind: 'reasoning' }] };
  expect(await proposeQuiz({ version: 1, binding, sourceRevision: snapshot.sourceRevision, answers: [a] }, owner)).toMatchObject({ ok: true });
  const lines = (await readFile(join(root, 'quiz', 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(lines.find(line => line.operation === 'read' && line.phase === 'outcome')).toMatchObject({ runId: result.meta.runId, assessmentRef: 'ed:7:11', code: 'OK' });
});
it('audit failure prevents trusted-read replacement and bounded failures preserve prior snapshot', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'quiz-read-failure-'))); dirs.push(root); const files = new QuizFiles(root);
  const evidence = new FileEvidence(files);
  const old = { assessmentRef: 'ed:7:11', questions: [{ ref: 'ed:7:11:21:31', supported: true, type: 'text', prompt: 'Previous synthetic prompt.' }],
    sources: [{ sourceItemId: 'ed:7:11:21:31', text: 'Previous synthetic prompt.', locator: 'question:31' }],
    coverage: { complete: true, scope: 'assessment', total: 1, supported: 1, unsupported: 0 } };
  await evidence.saveRead(old); const before = await evidence.read('ed:7:11');
  for (const [prompt, audit, code] of [['New synthetic prompt.', new AuditTrail(async () => { throw Error('SECRET-SENTINEL'); }), 'INTERNAL'],
    ['界'.repeat(24000), new AuditTrail(line => files.append('audit', line)), 'LIMIT_EXCEEDED']] as const) {
    const bodies = [{ lessons: [{ id: 11, kind: 'attempt' }] }, { lesson: { id: 11, slides: [{ id: 21 }] } }, { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt }] } }];
    expect(await readQuiz(target, { files, audit, store: { load: async () => ({ status: 'valid', selection: selected }), save: async () => {} },
      openSession: async () => ({ transport: { read: async () => ({ kind: 'json', status: 200, body: bodies.shift() }) }, close: async () => {} }) })).toMatchObject({ ok: false, error: { code } });
    expect(await evidence.read('ed:7:11')).toEqual(before);
  }
});
