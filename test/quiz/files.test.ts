import { afterEach, expect, it, vi } from 'vitest';
import { fsyncSync } from 'node:fs';
import { mkdtemp, realpath, readFile, stat, symlink, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizFiles } from '../../src/quiz/files.js';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const root = await realpath(await mkdtemp(join(tmpdir(), 'quiz-files-'))); directories.push(root); return { root, files: new QuizFiles(root) }; }
it('writes atomic private records and appends rather than replacing audit', async () => {
  const { root, files } = await setup();
  await files.write('proposal-synthetic', { revision: 1 }); await files.write('proposal-synthetic', { revision: 2 });
  expect(await files.read('proposal-synthetic')).toEqual({ revision: 2 });
  await files.append('audit', '{"code":"OK"}\n'); await files.append('audit', '{"code":"INVALID_INPUT"}\n');
  expect(await readFile(join(root, 'quiz', 'audit.jsonl'), 'utf8')).toBe('{"code":"OK"}\n{"code":"INVALID_INPUT"}\n');
  expect((await stat(join(root, 'quiz'))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, 'quiz', 'proposal-synthetic.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, 'quiz', 'audit.jsonl'))).mode & 0o777).toBe(0o600);
});
it('cancellation during write preparation preserves pending state and cleans the temporary file', async () => {
  const { root, files } = await setup(); const controller = new AbortController();
  await files.write('review-synthetic', { status: 'pending' });
  const value = { toJSON() { queueMicrotask(() => controller.abort()); return { status: 'approved' }; } };
  // Exercise the real storage path after preparation has begun, before activation.
  await expect(files.write('review-synthetic', value, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await files.read('review-synthetic')).toEqual({ status: 'pending' });
  expect(await readdir(join(root, 'quiz'))).toEqual(['review-synthetic.json']);
});
it('a directory sync failure after rename leaves no usable approval', async () => {
  const { root, files } = await setup();
  await files.write('review-synthetic', { status: 'pending' });
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }); });
  await expect(files.write('review-synthetic', { status: 'approved' }, new AbortController().signal)).rejects.toMatchObject({ code: 'EIO' });
  expect(await files.read('review-synthetic')).not.toMatchObject({ status: 'approved' });
  expect((await readdir(join(root, 'quiz'))).some(name => name.endsWith('.tmp'))).toBe(false);
});
it.each(['../outside', 'ed:7:11', '/absolute', 'a/b', '.'])('rejects malformed filename %s', async name => {
  const { files } = await setup(); await expect(files.write(name, {})).rejects.toThrow();
});
it('rejects directory, ancestor, record and audit symlink escapes', async () => {
  const { root, files } = await setup(); const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, 'quiz')); await expect(files.write('proposal-synthetic', {})).rejects.toThrow();
  await rm(join(root, 'quiz')); await mkdir(join(root, 'quiz'), { mode: 0o700 });
  await writeFile(join(outside, 'victim'), 'preserved');
  await symlink(join(outside, 'victim'), join(root, 'quiz', 'proposal-synthetic.json'));
  await expect(files.write('proposal-synthetic', {})).rejects.toThrow();
  await symlink(join(outside, 'victim'), join(root, 'quiz', 'audit.jsonl')); await expect(files.append('audit', 'unsafe')).rejects.toThrow();
  expect(await readFile(join(outside, 'victim'), 'utf8')).toBe('preserved');
  await symlink(outside, join(root, 'alias')); await expect(new QuizFiles(join(root, 'alias', 'child')).write('test', {})).rejects.toThrow();
});
it('exclusive mutations reject competing writers and preserve previous revision on failure', async () => {
  const { files } = await setup(); await files.write('proposal-synthetic', { revision: 1 });
  await files.exclusive(async () => {
    await expect(files.exclusive(async () => files.write('proposal-synthetic', { revision: 2 }))).rejects.toThrow();
  });
  expect(await files.read('proposal-synthetic')).toEqual({ revision: 1 });
  await files.exclusive(async () => files.write('proposal-synthetic', { revision: 3 }));
  expect(await files.read('proposal-synthetic')).toEqual({ revision: 3 });
});
it('repairs permissions before reading an existing owner record', async () => {
  const { root, files } = await setup(); await files.write('private-record', { synthetic: true });
  const { chmod } = await import('node:fs/promises'); const path = join(root, 'quiz', 'private-record.json');
  await chmod(path, 0o644); expect(await files.read('private-record')).toEqual({ synthetic: true });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
it('uses ignored local default or private external override and rejects repository source directories', async () => {
  const { packageRoot } = await import('../../src/config/data-dir.js');
  const { vi } = await import('vitest');
  const { root } = await setup();
  vi.stubEnv('COURSEWORK_HOME', '');
  try {
    expect(new QuizFiles().root).toBe(join(packageRoot(), '.local'));
    expect(await readFile(join(packageRoot(), '.gitignore'), 'utf8')).toMatch(/^\.local\/$/m);
    vi.stubEnv('COURSEWORK_HOME', root); expect(new QuizFiles().root).toBe(root);
    expect(() => new QuizFiles(join(packageRoot(), 'src'))).toThrow();
  } finally { vi.unstubAllEnvs(); }
});

it.each(['..quiz-private', '..quiz-private/nested', '...', '.local-private', '.local/../..quiz-private'])('rejects repository-private lookalike directory %s, including environment overrides', async name => {
  const { packageRoot } = await import('../../src/config/data-dir.js');
  const { vi } = await import('vitest');
  const root = join(packageRoot(), name);
  expect(() => new QuizFiles(root)).toThrow(/unavailable/i);
  vi.stubEnv('COURSEWORK_HOME', root);
  try { expect(() => new QuizFiles()).toThrow(/unavailable/i); }
  finally { vi.unstubAllEnvs(); }
});
it('allows .local descendants and genuinely external parent-segment paths', async () => {
  const { packageRoot } = await import('../../src/config/data-dir.js');
  expect(new QuizFiles(join(packageRoot(), '.local', 'nested')).root).toBe(join(packageRoot(), '.local', 'nested'));
  const outside = join(packageRoot(), '..', '..quiz-private');
  expect(new QuizFiles(outside).root).toBe(outside);
  expect(() => new QuizFiles(packageRoot())).toThrow();
});
it('reports uncertainty and retains an installed ordinary record after directory durability failure', async () => {
  const { files } = await setup(); await files.write('policy-synthetic', { cap: 2 });
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }); });
  await expect(files.write('policy-synthetic', { cap: 3 })).rejects.toMatchObject({ code: 'UNCERTAIN' });
  expect(await files.read('policy-synthetic')).toEqual({ cap: 3 });
});
