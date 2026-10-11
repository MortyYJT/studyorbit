import { randomUUID } from 'node:crypto';
import { mkdir, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../config/data-dir.js';
import { safeEdEndpoint } from './ed-transport.js';

function withoutAuth(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAuth);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:headers|cookies?|authorization|x-token|.*token.*|push_key|push_subscriptions)$/i.test(key))
    .map(([key, item]) => [key, withoutAuth(item)]));
  return value;
}
/** Private raw storage only. This writer is not a model-facing ingestion/export API. */
export async function writeEdSnapshot(endpoint: string, body: unknown, status: number, home = dataDir()): Promise<string> {
  if (!safeEdEndpoint(endpoint) || !Number.isInteger(status) || status < 200 || status >= 300) throw new Error('Invalid Ed snapshot metadata.');
  if (endpoint === '/api/user') {
    body = Array.isArray(body) ? body : body && typeof body === 'object' ? (body as Record<string, unknown>).courses : undefined;
    if (!Array.isArray(body)) throw new Error('Invalid Ed course discovery snapshot.');
  }
  const response = JSON.stringify(withoutAuth(body));
  if (response === undefined) throw new Error('Invalid Ed JSON snapshot.');
  const capturedAt = new Date().toISOString();
  const directory = join(home, 'snapshots', 'edstem.org', `${capturedAt.replaceAll(':', '-')}-${randomUUID()}`);
  // Tighten pre-existing parent directories as well as newly created ones.
  for (const path of [home, join(home, 'snapshots'), join(home, 'snapshots', 'edstem.org')]) {
    await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
  }
  await mkdir(directory, { mode: 0o700 });
  const metadata = { source: 'ed', endpoint, capturedAt, status,
    ...(endpoint.endsWith('/threads?limit=30&sort=new') ? { pagination: { limit: 30, sort: 'new' } } : {}) };
  for (const [filename, content] of [['response.json', response], ['meta.json', JSON.stringify(metadata)]]) {
    const handle = await open(join(directory, filename), 'wx', 0o600);
    try { await handle.writeFile(content + '\n'); await handle.sync(); }
    finally { await handle.close(); }
  }
  return directory;
}
