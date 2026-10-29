import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireServerLock, LOCK_FILE, SERVER_RUNNING_MESSAGE } from '../scripts/lib/server-lock.mjs';

// Scenarios from specs/sync-job-store/spec.md, "Single server instance" (design §5). Temporary directories only.
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'server-lock-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const lockPath = () => join(dir, '.local', LOCK_FILE);

/** The PID of a process that has already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', env: { ...process.env, NODE_DEBUG: '' } });
  return Number(child.stdout);
}

describe('server lock', () => {
  it('creates .local/server.lock (0600) holding the PID and removes it on release', async () => {
    const lock = acquireServerLock(dir);
    expect(lockPath()).toBe(join(dir, '.local', 'server.lock'));
    expect(await readFile(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
    expect((await stat(lockPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, '.local'))).mode & 0o777).toBe(0o700);
    lock.release();
    expect(existsSync(lockPath())).toBe(false);
    lock.release();
  });

  it('refuses to start while the lock names a live process and leaves that lock alone', async () => {
    const first = acquireServerLock(dir);
    expect(() => acquireServerLock(dir)).toThrow(SERVER_RUNNING_MESSAGE);
    expect(SERVER_RUNNING_MESSAGE).toBe('另一个 StudyOrbit 本地服务正在运行');
    try { acquireServerLock(dir); } catch (error) { expect((error as { code?: string }).code).toBe('SERVER_RUNNING'); }
    expect(await readFile(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
    first.release();
  });

  it('replaces a stale lock whose process is gone, or an old one that holds no PID', async () => {
    await mkdir(join(dir, '.local'), { recursive: true });
    await writeFile(lockPath(), `${deadPid()}\n`);
    acquireServerLock(dir).release();
    await writeFile(lockPath(), 'not a pid');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath(), old, old);
    const lock = acquireServerLock(dir);
    expect(await readFile(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
    lock.release();
  });

  it('does not remove a lock that another process has taken since', async () => {
    const lock = acquireServerLock(dir);
    await writeFile(lockPath(), '999999\n');
    lock.release();
    expect(await readFile(lockPath(), 'utf8')).toBe('999999\n');
  });

  it('never exposes an empty lock file and leaves no temporary file behind', async () => {
    const lock = acquireServerLock(dir);
    expect(await readdir(join(dir, '.local'))).toEqual(['server.lock']);
    lock.release();
  });

  it('treats an empty or unreadable lock younger than a few seconds as held, and an older one as stale', async () => {
    await mkdir(join(dir, '.local'), { recursive: true });
    await writeFile(lockPath(), '');
    expect(() => acquireServerLock(dir)).toThrow(SERVER_RUNNING_MESSAGE);
    expect(await readFile(lockPath(), 'utf8')).toBe('');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath(), old, old);
    acquireServerLock(dir).release();
  });

  it('treats a lock written before the last boot as stale even if its PID is alive again', async () => {
    await mkdir(join(dir, '.local'), { recursive: true });
    // process.pid is certainly alive; the PID was reused after a reboot.
    await writeFile(lockPath(), `${process.pid}\n`);
    const beforeBoot = new Date(Date.now() - uptime() * 1000 - 60_000);
    await utimes(lockPath(), beforeBoot, beforeBoot);
    const lock = acquireServerLock(dir);
    expect(await readFile(lockPath(), 'utf8')).toBe(`${process.pid}\n`);
    expect((await stat(lockPath())).mtimeMs).toBeGreaterThan(beforeBoot.getTime() + 30_000);
    lock.release();
  });
});
