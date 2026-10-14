import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as config from '../../src/config/data-dir.js';

it('resolves private delivery directories lazily inside the override and retains old crawls', () => {
  const home = mkdtempSync(join(tmpdir(), 'coursework-private-'));
  vi.stubEnv('COURSEWORK_HOME', home);
  try {
    mkdirSync(join(home, 'crawls'));
    writeFileSync(join(home, 'crawls', 'synthetic.txt'), 'retain');
    for (const [method, name] of [['materialsDir', 'materials'], ['screenshotsDir', 'screenshots'], ['agentWorkspaceDir', 'agent-workspace']] as const) {
      const path = join(home, name);
      expect(existsSync(path)).toBe(false);
      const create = (config as unknown as Record<string, () => string>)[method];
      expect(create).toBeTypeOf('function');
      expect(create()).toBe(path);
      expect(statSync(path).mode & 0o777).toBe(0o700);
      // Existing directories must also be private, irrespective of the process umask.
      execFileSync('chmod', ['755', path]);
      create();
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(join(home, 'crawls', 'synthetic.txt'), 'utf8')).toBe('retain');
  } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
});
it('git ignores every delivery data path', () => {
  const paths = ['.local/coursework.db', '.local/browser.json', '.local/materials/', '.local/screenshots/', '.local/agent-workspace/'];
  expect(execFileSync('git', ['check-ignore', ...paths], { encoding: 'utf8' }).trim().split('\n')).toEqual(paths);
});
