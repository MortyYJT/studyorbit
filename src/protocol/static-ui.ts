import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const types: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
};
/** Only build entry points and Vite assets are public. No SPA fallback for unknown paths. */
export async function readStaticUI(directory: string, url: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  const path = url === '/' ? '/index.html' : url;
  if (!['/index.html', '/favicon.ico', '/favicon.svg'].includes(path)
    && !/^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:js|css|svg|png|jpe?g|webp|ico|woff2?)$/.test(path)) return;
  const parts = path.slice(1).split('/');
  try {
    let current = resolve(directory);
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink()) return;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return;
    }
    const file = await open(join(current, parts.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return;
      return { body: await file.readFile(), contentType: types[path.split('.').at(-1)!]! };
    } finally { await file.close(); }
  } catch { return; }
}
