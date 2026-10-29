// Single-instance lock for the local server (design §5, decision #344): `.local/server.lock` holds the server's PID and
// is created exclusively before the store is opened, so a second server cannot mark the first one's running job as
// interrupted. A lock whose process is gone (or which holds no PID) is stale and replaced.
// The PID is written to a temporary file that is then hard-linked to the lock name, so the lock never exists without
// its PID (a link fails with EEXIST while the lock is held). Two servers starting in the same instant over a stale lock
// could both replace it; `npm run dev` starts one server, so that window is accepted.
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILE = 'server.lock';
export const SERVER_RUNNING_MESSAGE = '另一个 StudyOrbit 本地服务正在运行';
// A lock without a readable PID this young may come from a server of another version mid-write: treat it as held.
const UNREADABLE_GRACE_MS = 5000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

function readPid(path) {
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** True while the existing lock must be respected; a missing lock counts as free. */
function lockIsHeld(path) {
  let modified;
  let pid;
  try {
    modified = statSync(path).mtimeMs;
    pid = readPid(path);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  // Written before this boot: whatever process holds that PID now is not the old server (PID reuse after a crash).
  if (modified < Date.now() - uptime() * 1000) return false;
  if (pid === null) return Date.now() - modified < UNREADABLE_GRACE_MS;
  return isAlive(pid);
}

/** Takes the lock or throws an error with code `SERVER_RUNNING`. `release()` removes it only while it is still ours. */
export function acquireServerLock(projectDir) {
  const dir = join(projectDir, '.local');
  const path = join(dir, LOCK_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n`;
  const running = () => Object.assign(new Error(SERVER_RUNNING_MESSAGE), { code: 'SERVER_RUNNING' });
  const create = () => {
    const temp = join(dir, `${LOCK_FILE}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
      linkSync(temp, path);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  };
  if (!create()) {
    if (lockIsHeld(path)) throw running();
    rmSync(path, { force: true });
    if (!create()) throw running();
  }
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        if (readFileSync(path, 'utf8') === content) rmSync(path, { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}
