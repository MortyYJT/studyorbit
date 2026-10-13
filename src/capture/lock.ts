import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profilesDir } from '../config/data-dir.js';

import { CourseworkError } from '../protocol/errors.js';

function locked(holder: string): CourseworkError {
  return new CourseworkError('LOCKED', `Browser profile is locked by process ${holder || 'unknown'}.`);
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export interface ProfileLockOptions {
  directory?: string; pid?: number; isAlive?: (pid: number) => boolean; now?: () => number;
}
export type ProfileLock = (() => void) & { transfer(pid: number): void };
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (code(error) === 'ESRCH') return false; if (code(error) === 'EPERM') return true; throw error; }
}
export function releaseProfileLock(pid: number, directory: string): void {
  const path = join(directory, 'default.lock');
  try {
    const identity = statSync(path);
    if (readFileSync(path, 'utf8') !== String(pid)) return;
    const current = statSync(path);
    if (identity.ino === current.ino && identity.dev === current.dev && readFileSync(path, 'utf8') === String(pid)) unlinkSync(path);
  }
  catch (error) { if (code(error) !== 'ENOENT') throw error; }
}
export function acquireProfileLock(options: ProfileLockOptions = {}): ProfileLock {
  const path = join(options.directory ?? profilesDir(), 'default.lock');
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processIsAlive;
  for (;;) {
    let descriptor: number;
    try { descriptor = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      let holder: string;
      let identity: ReturnType<typeof statSync>;
      try { identity = statSync(path); holder = readFileSync(path, 'utf8'); }
      catch (readError) { if (code(readError) === 'ENOENT') continue; throw readError; }
      if (holder === '' && now() - identity.mtimeMs > 10_000) {
        // Recheck identity, content and age before reclaiming an interrupted write.
        try {
          const current = statSync(path);
          if (current.ino === identity.ino && current.dev === identity.dev
            && now() - current.mtimeMs > 10_000 && readFileSync(path, 'utf8') === '') {
            unlinkSync(path);
          }
        } catch (removeError) { if (code(removeError) !== 'ENOENT') throw removeError; }
        continue;
      }
      const pid = Number(holder);
      if (!/^\d+$/.test(holder) || !Number.isSafeInteger(pid) || pid <= 0) throw locked(holder);
      if (!isAlive(pid)) {
        // Recheck inode and holder: a replacement or a transferred lock is not the stale one.
        try {
          const current = statSync(path);
          if (current.ino === identity.ino && current.dev === identity.dev && readFileSync(path, 'utf8') === holder) unlinkSync(path);
        } catch (removeError) { if (code(removeError) !== 'ENOENT') throw removeError; }
        continue;
      }
      throw locked(holder);
    }
    try { writeFileSync(descriptor, String(options.pid ?? process.pid)); }
    catch (error) { closeSync(descriptor); unlinkSync(path); throw error; }
    let identity = statSync(path);
    closeSync(descriptor);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        const current = statSync(path);
        if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
      } catch (error) { if (code(error) !== 'ENOENT') throw error; }
    };
    return Object.assign(release, { transfer(pid: number) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock owner.');
      const current = statSync(path);
      if (released || current.ino !== identity.ino || current.dev !== identity.dev) throw locked('unknown');
      // Replace atomically so the new holder gets a new inode that stale-lock checks can detect.
      const temporary = `${path}.${pid}.tmp`;
      writeFileSync(temporary, String(pid), { mode: 0o600 });
      try { renameSync(temporary, path); }
      catch (error) { try { unlinkSync(temporary); } catch { /* best effort */ } throw error; }
      identity = statSync(path);
    } });
  }
}
