import { randomUUID } from 'node:crypto';
import { mkdir, chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../config/data-dir.js';
import { safeCanvasEndpoint } from './canvas-transport.js';
/** Canvas raw snapshots stay private, separate from the redacted local model. */
export async function writeCanvasSnapshot(endpoint: string, body: unknown, status: number, home = dataDir()): Promise<void> {
  if (!safeCanvasEndpoint(endpoint) || status < 200 || status >= 300) throw new Error('Invalid snapshot metadata.');
  const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:headers|cookies?|authorization|.*token.*|password)$/i.test(key)).map(([key, item]) => [key, clean(item)])) : value;
  const directory = join(home, 'snapshots', 'canvas');
  for (const path of [home, join(home, 'snapshots'), directory]) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
  const handle = await open(join(directory, `${randomUUID()}.json`), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ endpoint, status, body: clean(body) })); await handle.sync(); }
  finally { await handle.close(); }
}
