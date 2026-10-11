import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, chmod, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { packageRoot } from '../config/data-dir.js';
import { CourseworkError } from '../protocol/errors.js';
import { localId } from './policy.js';
const unavailable = () => new CourseworkError('INTERNAL', 'Private quiz storage is unavailable.');
/** No caller references become path components; symbolic links and hard-linked files fail closed. */
export class QuizFiles {
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
  async records(prefix: string): Promise<string[]> {
    if (!localId.safeParse(prefix).success) throw unavailable();
    const names = (await readdir(await this.directory())).filter(name => name.startsWith(prefix) && name.endsWith('.json')).map(name => name.slice(0, -5));
    if (names.length > 1000 || names.some(name => !localId.safeParse(name).success)) throw unavailable();
    return names.sort();
  }
  async write(name: string, value: unknown): Promise<void> {
    const path = await this.path(name); const temporary = `${path}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(value) + '\n'; if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw unavailable();
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(serialized); await handle.sync(); await handle.close();
      await this.path(name); await rename(temporary, path);
    } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw unavailable(); }); }
  }
  async append(name: 'audit' | 'runs', line: string): Promise<void> {
    const path = await this.path(name, 'jsonl');
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw unavailable();
      await handle.chmod(0o600); await handle.writeFile(line); await handle.sync();
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
