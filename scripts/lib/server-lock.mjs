// Single-instance lock for the local server (design §5, decision #344): `.local/server.lock` holds the server's PID and
// is created exclusively before the store is opened, so a second server cannot mark the first one's running job as
// interrupted. A lock whose process is gone (or which holds no PID) is stale and replaced.
// Two servers starting in the same instant over a stale lock could both replace it; `npm run dev` starts one server,
// so that window is accepted rather than adding a second locking scheme.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'server.lock';
export const SERVER_RUNNING_MESSAGE = '另一个 StudyOrbit 本地服务正在运行';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

function lockHolder(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Takes the lock or throws an error with code `SERVER_RUNNING`. `release()` removes it only while it is still ours. */
export function acquireServerLock(projectDir) {
  const dir = join(projectDir, '.local');
  const path = join(dir, LOCK_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const content = `${process.pid}\n`;
  const running = () => Object.assign(new Error(SERVER_RUNNING_MESSAGE), { code: 'SERVER_RUNNING' });
  const create = () => {
    try {
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (!create()) {
    const holder = lockHolder(path);
    if (holder !== null && isAlive(holder)) throw running();
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
