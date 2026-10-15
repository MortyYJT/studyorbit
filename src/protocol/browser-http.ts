import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { screenshotsDir } from '../config/data-dir.js';
import { CourseworkError } from './errors.js';
/** Owner-only routes are admitted by the HTTP session gate before any filesystem access. */
export function browserOwnerRoute(url: string): 'view' | 'image' | undefined {
  return /^\/api\/browser\.(view|image)(?:\?|$)/.exec(url)?.[1] as 'view' | 'image' | undefined;
}
export function browserQuery(url: string, key: string): string {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  const values = params.getAll(key);
  if (values.length !== 1 || [...params.keys()].some(k => k !== key) || !z.uuid().safeParse(values[0]).success) throw new CourseworkError('INVALID_INPUT', 'Invalid browser reference.');
  return values[0]!;
}
export async function browserImage(ref: string): Promise<Buffer> {
  if (!z.uuid().safeParse(ref).success) throw new CourseworkError('INVALID_INPUT', 'Invalid screenshot reference.');
  let file;
  try {
    file = await open(join(screenshotsDir(), `${ref}.png`), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024 || process.getuid && info.uid !== process.getuid()) throw new Error();
    return await file.readFile();
  } catch { throw new CourseworkError('NOT_FOUND', 'Screenshot unavailable.'); }
  finally { await file?.close(); }
}
