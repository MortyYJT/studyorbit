import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { dataDir, resolveDataDir, databasePath, snapshotsDir, profilesDir, crawlsDir, packageRoot } from '../../src/config/data-dir.js';

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
it('defaults to the package root regardless of the working directory', () => {
  vi.stubEnv('COURSEWORK_HOME', undefined);
  expect(resolveDataDir()).toBe(join(packageRoot(), '.local'));
  expect(packageRoot()).toBe(resolve('.'));
});
it('creates database parent, snapshots and profiles inside the override', () => {
  const root = mkdtempSync(join(tmpdir(), 'coursework-config-'));
  temporary.push(root);
  const home = join(root, 'nested', 'home');
  vi.stubEnv('COURSEWORK_HOME', home);
  expect(dataDir()).toBe(home);
  expect(databasePath()).toBe(join(home, 'coursework.db'));
  expect(snapshotsDir()).toBe(join(home, 'snapshots'));
  expect(profilesDir()).toBe(join(home, 'profiles'));
  expect(crawlsDir()).toBe(join(home, 'crawls'));
  expect(existsSync(crawlsDir())).toBe(true);
  expect(existsSync(snapshotsDir())).toBe(true);
  expect(existsSync(profilesDir())).toBe(true);
});

it.each(['', '   ', '\t\n'])('treats blank COURSEWORK_HOME %j as unset', (home) => {
  vi.stubEnv('COURSEWORK_HOME', home);
  expect(resolveDataDir()).toBe(join(packageRoot(), '.local'));
});
