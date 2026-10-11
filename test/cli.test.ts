import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, expect, it } from 'vitest';

beforeAll(() => { execFileSync('npm', ['run', 'build'], { stdio: 'pipe' }); });

it('coursework --version prints the package version', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  expect(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }))
    .toBe(`${pkg.version}\n`);
});


it('non-TTY locked capture returns one LOCKED envelope before launching a browser', () => {
  const home = mkdtempSync(join(tmpdir(), 'coursework-cli-'));
  try {
    mkdirSync(join(home, 'profiles'));
    writeFileSync(join(home, 'capture-selection.json'), JSON.stringify({ version: 1, courses: [] }));
    const lock = join(home, 'profiles', 'default.lock');
    writeFileSync(lock, String(process.pid));
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'capture'], {
      env: { ...process.env, COURSEWORK_HOME: home }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each([[], ['--crawl'], ['--reselect'], ['--crawl', '--reselect']].map(flags => ({ flags })))('non-TTY capture flags %j return early INVALID_INPUT with no prompt', ({ flags }) => {
  const home = mkdtempSync(join(tmpdir(), 'coursework-cli-selection-'));
  try {
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'capture', ...flags], {
      env: { ...process.env, COURSEWORK_HOME: home, COURSEWORK_BROWSER: 'invalid' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(result.stderr).toBe('');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
