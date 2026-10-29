import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LISTENING_LINE, parseServerEnv } from '../server/main.ts';
import { TOKEN_HEADER } from '../server/guard.ts';
import { call, closeServer, listen, syntheticToken } from './local-api-helpers.ts';

// Startup of `server/main.ts` (design §2, §5, §8; specs/local-api-server and sync-job-store): environment parsing,
// the single-instance lock, an unavailable store, a port in use and signals. Child processes run `main()` against a
// temporary project directory and HOME, never the repository's `.local`.
const mainUrl = new URL('../server/main.ts', import.meta.url).href;
let root: string, projectDir: string;
const children: ChildProcess[] = [];
let blocker: Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studyorbit-main-'));
  projectDir = join(root, 'project');
  await mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closeServer(blocker);
  blocker = undefined;
  await rm(root, { recursive: true, force: true });
});

type Run = { child: ChildProcess; output: () => string; errors: () => string; exited: Promise<number | null>; listening: Promise<number> };

function run(env: Record<string, string | undefined>): Run {
  const script = `const { main } = await import(${JSON.stringify(mainUrl)}); await main({ projectDir: process.argv[1] });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, projectDir], {
    env: { PATH: process.env.PATH, HOME: root, NODE_DEBUG: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  const listening = new Promise<number>((resolve, reject) => {
    child.stdout!.on('data', () => {
      const match = new RegExp(`${LISTENING_LINE} http://127\\.0\\.0\\.1:(\\d+)`).exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    void exited.then(code => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  listening.catch(() => {});
  return { child, output: () => stdout, errors: () => stderr, exited, listening };
}

const token = syntheticToken();
const env = (more: Record<string, string> = {}) => ({ STUDYORBIT_API_TOKEN: token, STUDYORBIT_API_PORT: '0', STUDYORBIT_WEB_PORT: '5999', ...more });
const lockPath = () => join(projectDir, '.local', 'server.lock');
const statusOf = (port: number) => call(port, '/api/local/course-sync', { headers: { host: 'localhost:5999', [TOKEN_HEADER]: token } });

describe('parseServerEnv', () => {
  it('reads the token and both ports with their defaults', () => {
    expect(parseServerEnv({ STUDYORBIT_API_TOKEN: token })).toEqual({ token, apiPort: 5190, webPort: 5173 });
    expect(parseServerEnv({ STUDYORBIT_API_TOKEN: token, STUDYORBIT_API_PORT: '6100', STUDYORBIT_WEB_PORT: '5181' })).toEqual({ token, apiPort: 6100, webPort: 5181 });
  });

  it('refuses a missing, short or non-hex token and invalid ports, naming the variable', () => {
    for (const value of [undefined, '', 'ab'.repeat(15), 'g'.repeat(32), ` ${token}`]) {
      expect(() => parseServerEnv({ STUDYORBIT_API_TOKEN: value })).toThrow('STUDYORBIT_API_TOKEN');
    }
    for (const value of ['abc', '-1', '65536', '1.5', '']) {
      expect(() => parseServerEnv({ STUDYORBIT_API_TOKEN: token, STUDYORBIT_API_PORT: value })).toThrow('STUDYORBIT_API_PORT');
      expect(() => parseServerEnv({ STUDYORBIT_API_TOKEN: token, STUDYORBIT_WEB_PORT: value })).toThrow('STUDYORBIT_WEB_PORT');
    }
  });
});

describe('server/main.ts', () => {
  it('exits before listening without a valid token', async () => {
    const started = run(env({ STUDYORBIT_API_TOKEN: 'short' }));
    expect(await started.exited).toBe(1);
    expect(started.errors()).toContain('STUDYORBIT_API_TOKEN');
    expect(started.errors()).not.toContain(token);
    expect(started.output()).not.toContain(LISTENING_LINE);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('listens on 127.0.0.1, prints one listening line, serves routes and stops on SIGTERM, removing the lock', async () => {
    const started = run(env());
    const port = await started.listening;
    expect(started.output()).toBe(`${LISTENING_LINE} http://127.0.0.1:${port}\n`);
    expect(await readFile(lockPath(), 'utf8')).toBe(`${started.child.pid}\n`);
    expect((await statusOf(port)).json()).toEqual({ running: false, courses: [], error: null, jobId: null, resumable: false });
    expect(existsSync(join(projectDir, '.local', 'studyorbit.db'))).toBe(true);
    started.child.kill('SIGTERM');
    expect(await started.exited).toBe(0);
    expect(existsSync(lockPath())).toBe(false);
    expect(started.output()).not.toContain(token);
  });

  it('stops on SIGINT too', async () => {
    const started = run(env());
    // Signal right after the listening line: main() installs its handlers before printing it, so this cannot hit
    // the default action (exit code null, killed by the signal).
    await started.listening;
    started.child.kill('SIGINT');
    expect(await started.exited).toBe(0);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses a second server for the same project and leaves the first one running', async () => {
    const first = run(env());
    const port = await first.listening;
    const second = run(env());
    expect(await second.exited).toBe(1);
    expect(second.errors()).toContain('另一个 StudyOrbit 本地服务正在运行');
    expect(await readFile(lockPath(), 'utf8')).toBe(`${first.child.pid}\n`);
    expect((await statusOf(port)).status).toBe(200);
  });

  it('replaces a stale lock', async () => {
    await mkdir(join(projectDir, '.local'), { recursive: true });
    // A PID far above any live process on a test machine.
    await writeFile(lockPath(), '99999999\n');
    const started = run(env());
    await started.listening;
    expect(await readFile(lockPath(), 'utf8')).toBe(`${started.child.pid}\n`);
  });

  it('exits naming STUDYORBIT_API_PORT when the port is in use, without trying another port, and releases the lock', async () => {
    blocker = createServer();
    const port = await listen(blocker);
    const started = run(env({ STUDYORBIT_API_PORT: String(port) }));
    expect(await started.exited).toBe(1);
    expect(started.errors()).toContain('STUDYORBIT_API_PORT');
    expect(started.output()).not.toContain(LISTENING_LINE);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('starts with an unusable database, answers 503 on the sync route and leaves the file unchanged', async () => {
    await mkdir(join(projectDir, '.local'), { recursive: true });
    const bytes = 'not a sqlite database, synthetic bytes\n'.repeat(200);
    await writeFile(join(projectDir, '.local', 'studyorbit.db'), bytes);
    const started = run(env());
    const port = await started.listening;
    const reply = await statusOf(port);
    expect([reply.status, reply.json()]).toEqual([503, { error: 'SYNC_STORE_UNAVAILABLE' }]);
    expect(started.errors()).toContain('SYNC_STORE_UNAVAILABLE');
    expect(await readFile(join(projectDir, '.local', 'studyorbit.db'), 'utf8')).toBe(bytes);
  });
});
