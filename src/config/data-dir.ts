import { existsSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'coursework') {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot find the coursework package root');
    directory = parent;
  }
}

/** Resolve without creating directories, for read-only browser discovery and synthetic tests. */
export function resolveDataDir(): string {
  const home = process.env.COURSEWORK_HOME;
  return home?.trim() ? resolve(home) : join(packageRoot(), '.local');
}

export function dataDir(): string {
  const directory = resolveDataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function databasePath(): string { return join(dataDir(), 'coursework.db'); }
function subdirectory(name: string): string {
  const directory = join(dataDir(), name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function snapshotsDir(): string { return subdirectory('snapshots'); }
export function profilesDir(): string { return subdirectory('profiles'); }

export function crawlsDir(): string { return subdirectory('crawls'); }

function privateSubdirectory(name: string): string {
  const directory = subdirectory(name);
  chmodSync(directory, 0o700);
  return directory;
}
export function materialsDir(): string { return privateSubdirectory('materials'); }
export function screenshotsDir(): string { return privateSubdirectory('screenshots'); }
export function agentWorkspaceDir(): string { return privateSubdirectory('agent-workspace'); }
