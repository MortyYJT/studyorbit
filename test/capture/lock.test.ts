import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireProfileLock } from '../../src/capture/lock.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { profilesDir } from '../../src/config/data-dir.js';
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'coursework-lock-')); vi.stubEnv('COURSEWORK_HOME', home); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it('rejects a second capture with LOCKED and preserves the first holder', () => {
  const release = acquireProfileLock();
  const path = join(profilesDir(), 'default.lock');
  expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  expect(() => acquireProfileLock()).toThrow(CourseworkError);
  try { acquireProfileLock(); } catch (error) {
    expect(error).toMatchObject({ code: 'LOCKED', message: expect.stringContaining(String(process.pid)) });
  }
  expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  release(); release();
  expect(existsSync(path)).toBe(false);
});
it('reclaims a stale lock naming an exited process', () => {
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.status).toBe(0);
  const path = join(profilesDir(), 'default.lock');
  writeFileSync(path, String(child.pid));
  const release = acquireProfileLock();
  expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  release();
});
it('keeps a fresh empty lock locked while its holder may be writing the pid', () => {
  const path = join(profilesDir(), 'default.lock');
  writeFileSync(path, '');
  expect(() => acquireProfileLock()).toThrow(CourseworkError);
  expect(readFileSync(path, 'utf8')).toBe('');
});

it('reclaims an empty lock older than ten seconds', () => {
  const path = join(profilesDir(), 'default.lock');
  writeFileSync(path, '');
  const old = new Date(Date.now() - 11_000);
  utimesSync(path, old, old);
  const release = acquireProfileLock();
  expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
  release();
  expect(existsSync(path)).toBe(false);
});
it('keeps an empty lock at the ten-second boundary locked', () => {
  const path = join(profilesDir(), 'default.lock');
  writeFileSync(path, '');
  const now = Date.now();
  const old = new Date(now - 10_000);
  utimesSync(path, old, old);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect(() => acquireProfileLock()).toThrow(CourseworkError);
    expect(readFileSync(path, 'utf8')).toBe('');
  } finally { clock.mockRestore(); }
});
it('keeps an old nonempty malformed lock locked', () => {
  const path = join(profilesDir(), 'default.lock');
  writeFileSync(path, 'invalid');
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  expect(() => acquireProfileLock()).toThrow(CourseworkError);
  expect(readFileSync(path, 'utf8')).toBe('invalid');
});
it('does not reclaim a lock transferred to a live process during the stale check', () => {
  const first = acquireProfileLock({ pid: 100, isAlive: () => true });
  const path = join(profilesDir(), 'default.lock');
  expect(() => acquireProfileLock({ pid: 333, isAlive: pid => {
    if (pid === 100) { first.transfer(222); return false; }
    return pid === 222;
  } })).toThrow(/222/);
  expect(readFileSync(path, 'utf8')).toBe('222');
  first();
  expect(existsSync(path)).toBe(false);
});
