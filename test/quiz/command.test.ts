import { AuditTrail } from '../../src/quiz/audit.js';
import { expect, it, vi } from 'vitest';
import { readQuiz, quizReadCommand, type QuizReadDependencies } from '../../src/quiz/read/command.js';
import { parseQuizCLI } from '../../src/quiz/cli.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { selected, target } from './synthetic.js';
const setup = (prompt = 'Explain parity.') => {
  const close = vi.fn(async () => {});
  const bodies = [{ lessons: [{ id: 11, kind: 'attempt' }] }, { lesson: { id: 11, slides: [{ id: 21 }] } },
    { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt }, { id: 32, type: 'text', prompt: 'Explain odd numbers.' }] } }];
  const transport = { read: vi.fn(async () => ({ kind: 'json' as const, status: 200, body: bodies.shift() })) };
  const dependencies: QuizReadDependencies = { audit: new AuditTrail(async () => {}), store: { load: async () => ({ status: 'valid', selection: selected }), save: async () => {} },
    openSession: vi.fn(async () => ({ transport, close })) };
  return { dependencies, transport, close };
};
it('reusable handler returns a validated bounded envelope and releases its session', async () => {
  const f = setup(); const envelope = await readQuiz(target, f.dependencies);
  expect(envelope).toMatchObject({ protocol: 'coursework.agent/v1', command: 'quiz.read', ok: true, data: { assessmentRef: 'ed:7:11' } });
  expect(f.close).toHaveBeenCalledOnce();
});
it('invalid input, missing selection and unselected targets never launch a session', async () => {
  const f = setup();
  expect(await readQuiz({ ...target, lesson: 'private-sentinel' }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await readQuiz({ ...target, course: '8' }, f.dependencies)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  f.dependencies.store = { load: async () => ({ status: 'absent' }), save: async () => {} };
  expect(await readQuiz(target, f.dependencies)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(f.dependencies.openSession).not.toHaveBeenCalled();
});
it.each(['LOCKED', 'AUTH_EXPIRED', 'SOURCE_UNAVAILABLE', 'LIMIT_EXCEEDED'] as const)('sanitizes %s session errors and diagnostics', async code => {
  const f = setup(); f.dependencies.openSession = async () => { throw new CourseworkError(code, 'private-sentinel /private/profile'); };
  const stdout = vi.fn(); const stderr = vi.fn();
  await quizReadCommand(target, { ...f.dependencies, stdout, stderr });
  expect(stdout).toHaveBeenCalledOnce();
  expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ ok: false, error: { code } });
  expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toMatch(/private-sentinel|\/private\/profile/);
});
it('withholds source failures and raw exceptions and closes after read failure', async () => {
  const f = setup('<xml>private-sentinel</xml>');
  expect(await readQuiz(target, f.dependencies)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  expect(f.close).toHaveBeenCalledOnce();
  f.dependencies.store = { load: async () => { throw Error('private-sentinel'); }, save: async () => {} };
  expect(JSON.stringify(await readQuiz(target, f.dependencies))).not.toContain('private-sentinel');
});
it('enforces 64 KiB including metadata without truncating and supports exact narrowing', async () => {
  const f = setup('界'.repeat(24000)); const oversized = await readQuiz(target, f.dependencies);
  expect(oversized).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED', next: expect.stringContaining('Narrow') } });
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(65536);
  const narrow = setup('界'.repeat(24000));
  const result = await readQuiz({ ...target, questions: ['ed:7:11:21:32'] }, narrow.dependencies);
  expect(result).toMatchObject({ ok: true, data: { questions: [{ ref: 'ed:7:11:21:32', prompt: 'Explain odd numbers.' }], coverage: { scope: 'selection', total: 1 } } });
});
it('cleanup failure cannot report success or expose exception text', async () => {
  const f = setup(); f.close.mockImplementation(async () => { throw Error('private-sentinel'); });
  const result = await readQuiz(target, f.dependencies);
  expect(result).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  expect(JSON.stringify(result)).not.toContain('private-sentinel');
});
it('CLI emits one envelope, supports question selection and never prints Commander input errors', async () => {
  const f = setup(); const stdout = vi.fn(); const stderr = vi.fn();
  await parseQuizCLI(['quiz', 'read', '--course', '7', '--lesson', '11', '--question', 'ed:7:11:21:32'], { ...f.dependencies, stdout, stderr });
  expect(stdout).toHaveBeenCalledOnce(); expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ ok: true });
  for (const args of [['quiz', 'read'], ['quiz', 'read', '--private-sentinel'], ['quiz', 'read', '--course'], ['quiz', 'other-private-sentinel']]) {
    stdout.mockClear(); stderr.mockClear();
    await parseQuizCLI(args, { ...f.dependencies, stdout, stderr });
    expect(stdout).toHaveBeenCalledOnce(); expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('private-sentinel');
  }
});
it('generated legacy help keeps its exact usage receipt without source access', async () => {
  const f = setup(); const stdout = vi.fn();
  await parseQuizCLI(['quiz', 'read', '--help'], { ...f.dependencies, stdout });
  expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ command: 'quiz.read', ok: true,
    data: { usage: 'coursework quiz read --course <id> --lesson <id> [--question <ref>]' } });
  expect(f.dependencies.openSession).not.toHaveBeenCalled();
});
it('registry adaptation preserves Q1 sourceRevision and original safe failure details', async () => {
  const f = setup(); const stdout = vi.fn();
  await parseQuizCLI(['quiz', 'read', '--course', '7', '--lesson', '11'], { ...f.dependencies, stdout });
  expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ ok: true, data: { sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  stdout.mockClear();
  f.dependencies.openSession = async () => { throw new CourseworkError('AUTH_EXPIRED', 'private-sentinel'); };
  await parseQuizCLI(['quiz', 'read', '--course', '7', '--lesson', '11'], { ...f.dependencies, stdout, stderr: () => {} });
  expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ ok: false, error: { code: 'AUTH_EXPIRED',
    message: 'Quiz read could not complete.', next: 'Ask the user to sign in again.' } });
});
