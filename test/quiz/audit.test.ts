import { expect, it, vi } from 'vitest';
import { AuditTrail, auditedMutation } from '../../src/quiz/audit.js';
import { readQuiz } from '../../src/quiz/read/command.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { selected, target } from './synthetic.js';
const fixture = (prompt = 'Synthetic prompt') => {
  const bodies = [{ lessons: [{ id: 11, kind: 'attempt' }] }, { lesson: { id: 11, slides: [{ id: 21 }] } }, { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt }] } }];
  const lines: string[] = [];
  const audit = new AuditTrail(async (line: string) => { lines.push(line); });
  const deps = { audit, store: { load: async () => ({ status: 'valid' as const, selection: selected }), save: async () => {} },
    openSession: async () => ({ transport: { read: async () => ({ kind: 'json' as const, status: 200, body: bodies.shift() }) }, close: async () => {} }) };
  return { lines, audit, deps };
};
it('read success links envelope run to an append-only minimal outcome, without text', async () => {
  const f = fixture('QUESTION-SENTINEL'); const result = await readQuiz(target, f.deps);
  expect(result.ok).toBe(true); expect(f.lines).toHaveLength(1);
  expect(JSON.parse(f.lines[0])).toEqual({ version: 1, operation: 'read', phase: 'outcome', at: expect.any(String), runId: result.meta.runId, assessmentRef: 'ed:7:11', code: 'OK' });
  expect(f.lines.join('')).not.toContain('QUESTION-SENTINEL');
});
it.each(['INVALID_INPUT', 'AUTH_EXPIRED', 'SOURCE_UNAVAILABLE', 'LIMIT_EXCEEDED'] as const)('audits read %s after final envelope bounding without unsafe input', async code => {
  const f = fixture(code === 'LIMIT_EXCEEDED' ? '界'.repeat(24000) : '<unsafe>SOURCE-SENTINEL</unsafe>');
  const input = code === 'INVALID_INPUT' ? { course: 'PERSON-SENTINEL', lesson: 'TOKEN-SENTINEL' } : target;
  if (code === 'AUTH_EXPIRED') f.deps.openSession = async () => { throw new CourseworkError(code, 'x-token RAW-SENTINEL'); };
  const result = await readQuiz(input, f.deps);
  expect(result).toMatchObject({ ok: false, error: { code } }); expect(f.lines).toHaveLength(1);
  expect(JSON.parse(f.lines[0])).toMatchObject({ runId: result.meta.runId, code });
  expect(f.lines.join('')).not.toMatch(/SENTINEL|x-token|unsafe|界/);
  if (code !== 'LIMIT_EXCEEDED') expect(JSON.parse(f.lines[0]).assessmentRef).toBeUndefined();
});
it('confirmed assessment may be retained on bounded-output failure', async () => {
  const f = fixture('界'.repeat(24000)); const result = await readQuiz(target, f.deps);
  expect(JSON.parse(f.lines[0])).toMatchObject({ code: 'LIMIT_EXCEEDED', runId: result.meta.runId });
});
it('transport exceptions never enter audit, and invalid targets are not echoed', async () => {
  const f = fixture(); f.deps.openSession = async () => { throw Error('Authorization: PRIVATE-SENTINEL'); };
  await readQuiz(target, f.deps); await readQuiz({ ...target, lesson: '../PRIVATE-SENTINEL' }, f.deps);
  expect(f.lines).toHaveLength(2); expect(f.lines.join('')).not.toMatch(/PRIVATE|Authorization|\.\./);
});
it('audit failure denies mutation before effects; successful/failed operations link intent/outcome', async () => {
  const f = fixture(); const mutate = vi.fn(async () => 42);
  const broken = new AuditTrail(async () => { throw Error('private'); });
  expect(await auditedMutation('policy', broken, async () => mutate())).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(mutate).not.toHaveBeenCalled();
  const result = await auditedMutation('proposal', f.audit, async () => mutate(), { assessmentRef: 'ed:7:11' });
  expect(result.ok).toBe(true); expect(f.lines.map(line => JSON.parse(line))).toMatchObject([{ phase: 'intent', runId: result.meta.runId }, { phase: 'outcome', runId: result.meta.runId, code: 'OK' }]);
  const failed = await auditedMutation('grant', f.audit, async () => { throw new CourseworkError('INVALID_INPUT', 'PRIVATE-SENTINEL'); });
  expect(failed.ok).toBe(false); expect(f.lines.join('')).not.toContain('PRIVATE-SENTINEL');
});
it('read refuses a false success when auditing is unavailable', async () => {
  const f = fixture(); f.deps.audit = new AuditTrail(async () => { throw Error('PRIVATE-SENTINEL'); });
  expect(await readQuiz(target, f.deps)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
});
it('read events reject revision and policy metadata beyond the minimal read contract', async () => {
  const f = fixture();
  await expect(f.audit.record('read', 'outcome', '11111111-1111-4111-8111-111111111111', 'OK', { revision: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow();
  expect(f.lines).toHaveLength(0);
});
