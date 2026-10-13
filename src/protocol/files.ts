import { constants, openSync, closeSync, renameSync, fsyncSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, chmod, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { packageRoot } from '../config/data-dir.js';
import { CourseworkError } from '../protocol/errors.js';
import { localId } from './policy.js';
const unavailable = () => new CourseworkError('INTERNAL', 'Private quiz storage is unavailable.');
/** No caller references become path components; symbolic links and hard-linked files fail closed. */
export class ProtocolFiles {
  readonly root: string;
  constructor(root?: string) {
    this.root = resolve(root ?? (process.env.COURSEWORK_HOME?.trim() || join(packageRoot(), '.local')));
    const inRepository = relative(packageRoot(), this.root);
    const outsideRepository = isAbsolute(inRepository) || inRepository === '..' || inRepository.startsWith(`..${sep}`);
    if (!outsideRepository && inRepository !== '.local' && !inRepository.startsWith(`.local${sep}`)) throw unavailable();
  }
  private async directory(): Promise<string> {
    const paths: string[] = []; let path = join(this.root, 'quiz');
    while (dirname(path) !== path) { paths.unshift(path); path = dirname(path); }
    for (const directory of paths) {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(); }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      if (directory === this.root || directory === join(this.root, 'quiz')) {
        if (process.getuid && info.uid !== process.getuid()) throw unavailable();
        await chmod(directory, 0o700);
      }
    }
    return join(this.root, 'quiz');
  }
  private async path(name: string, extension = 'json'): Promise<string> {
    if (!localId.safeParse(name).success) throw new CourseworkError('INVALID_INPUT', 'Invalid private record reference.');
    const path = join(await this.directory(), `${name}.${extension}`);
    try { const info = await lstat(path); if (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw unavailable(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(); }
    return path;
  }
  async read(name: string): Promise<unknown | undefined> {
    const path = await this.path(name); let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat(); if (!info.isFile() || info.size > 4 * 1024 * 1024 || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw unavailable();
      await handle.chmod(0o600);
      return JSON.parse(await handle.readFile('utf8')) as unknown;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw unavailable(); }
    finally { await handle?.close(); }
  }
  async readLog(name: 'audit' | 'runs'): Promise<unknown[]> {
    const path = await this.path(name, 'jsonl'); let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4 * 1024 * 1024 || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw unavailable();
      await handle.chmod(0o600);
      const text = await handle.readFile('utf8');
      if (text && !text.endsWith('\n')) throw unavailable();
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw unavailable(); }
    finally { await handle?.close(); }
  }
  async records(prefix: string): Promise<string[]> {
    if (!localId.safeParse(prefix).success) throw unavailable();
    const names = (await readdir(await this.directory())).filter(name => name.startsWith(prefix) && name.endsWith('.json')).map(name => name.slice(0, -5));
    if (names.length > 1000 || names.some(name => !localId.safeParse(name).success)) throw unavailable();
    return names.sort();
  }
  /** With a signal, cancellation remains effective until the synchronous durable commit. */
  async write(name: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const path = await this.path(name); const temporary = `${path}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(value) + '\n'; if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw unavailable();
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized); await handle.sync(); await handle.close();
      await this.path(name);
      if (signal) {
        let installed = false;
        try {
          const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            signal.throwIfAborted();
            // No event-loop yield between the final cancellation check and durable activation.
            renameSync(temporary, path); installed = true; fsyncSync(directory);
          } finally { closeSync(directory); }
        } catch (error) {
          if (installed) {
            // A failed durable commit must not expose the replacement after the lock is released.
            unlinkSync(path);
            const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
            try { fsyncSync(directory); } finally { closeSync(directory); }
          }
          throw error;
        }
      } else {
        let installed = false;
        try {
          await rename(temporary, path); installed = true;
          const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { fsyncSync(directory); } finally { closeSync(directory); }
        } catch (error) {
          if (installed) throw new CourseworkError('UNCERTAIN', 'Private record was installed but durability is uncertain; inspect local state before retrying.');
          throw error;
        }
      }
    } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw unavailable(); }); }
  }
  async append(name: 'audit' | 'runs', line: string): Promise<void> {
    const path = await this.path(name, 'jsonl');
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw unavailable();
      await handle.chmod(0o600); await handle.writeFile(line); await handle.sync();
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle.close(); }
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const path = join(await this.directory(), 'mutation.lock'); let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch { throw new CourseworkError('CONFLICT', 'A private quiz write is already active.'); }
    try { return await fn(); }
    finally { await handle.close(); await unlink(path); }
  }
}
