// Generic code contains no University of Melbourne literals (openspec change generic-adapters, design §4 "Guard
// test", spec institution-plugins). Everything specific to that institution lives in scripts/institutions/unimelb/;
// every other module under scripts/, server/, shared/ and web/src/ may mention it only where an entry below says why.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..');
const ROOTS = ['scripts', 'server', 'shared', join('web', 'src')];
const EXTENSIONS = /\.(?:mjs|ts|tsx|d\.mts)$/;
const PLUGIN_DIR = ['scripts', 'institutions', 'unimelb'].join('/') + '/';
/** Case-sensitive: the lowercase contract value `handbook` stays allowed. */
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'unimelb', pattern: /unimelb/ },
  { name: 'UniMelb', pattern: /UniMelb/ },
  { name: '墨尔本', pattern: /墨尔本/ },
  { name: 'Melbourne', pattern: /Melbourne/ },
  { name: 'Handbook', pattern: /Handbook/ },
  { name: 'subject-code pattern', pattern: /\[A-Z\]\{4\}\[1-9\]/ },
];

/**
 * Allowed lines: file, a test the line must match, and the reason. Keep this list short; a new entry needs a reason as
 * strong as these.
 */
const ALLOWED: { file: string; line: RegExp; reason: string }[] = [
  { file: 'scripts/institutions/registry.mjs', line: /unimelb/, reason: 'the registry maps the plugin id `unimelb` to its directory' },
  { file: 'scripts/institutions/types.d.mts', line: /^export type InstitutionId = 'unimelb' \| 'generic';$/, reason: 'the type of the registry ids, used by every other declaration' },
  { file: 'scripts/collect-handbook.mjs', line: /unimelb\/handbook-collect\.mjs/, reason: 'the old collector path, kept as a shim that forwards into the plugin (design, Migration Plan)' },
  { file: 'shared/course-calculations.ts', line: /UniMelb grade bands/, reason: 'grade bands H1 … P stay as they are; per-institution bands are out of scope (proposal, design Non-Goals)' },
  { file: 'shared/course-data.ts', line: /\.describe\('Collected platform IDs, or listed Handbook component names/, reason: 'schema descriptions are model input through the output JSON Schema and describe the kept contract value `handbook`; rewriting them would change every prompt and the evaluation baseline (design §4)' },
];

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(join(repo, dir), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : Promise.resolve(EXTENSIONS.test(entry.name) ? [path] : []);
  }));
  return nested.flat();
}

/** Every forbidden literal of the generic modules that no entry allows: `file:line: name: text`. */
export async function violations(): Promise<string[]> {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const path of await files(root)) {
      const file = relative(repo, join(repo, path)).split(sep).join('/');
      if (file.startsWith(PLUGIN_DIR)) continue;
      const lines = (await readFile(join(repo, path), 'utf8')).split('\n');
      lines.forEach((text, index) => {
        for (const { name, pattern } of FORBIDDEN) {
          if (!pattern.test(text)) continue;
          if (ALLOWED.some(entry => entry.file === file && entry.line.test(text))) continue;
          found.push(`${file}:${index + 1}: ${name}: ${text.trim().slice(0, 160)}`);
        }
      });
    }
  }
  return found;
}

describe('generic modules contain no institution literals', () => {
  it('finds none outside the plugin directory and the allowed entries', async () => {
    expect(await violations()).toEqual([]);
  });

  it('would catch a hard-coded host in a generic module', () => {
    const line = "const origin = 'https://canvas.lms.unimelb.edu.au';";
    expect(FORBIDDEN.filter(({ pattern }) => pattern.test(line)).map(({ name }) => name)).toEqual(['unimelb']);
    expect(ALLOWED.some(entry => entry.file === 'scripts/lib/course-list.mjs' && entry.line.test(line))).toBe(false);
  });

  it('allows the lowercase contract value and every entry has a reason', () => {
    expect(FORBIDDEN.some(({ pattern }) => pattern.test("ref.platform === 'handbook'"))).toBe(false);
    for (const entry of ALLOWED) expect(entry.reason.length, entry.file).toBeGreaterThan(20);
  });
});

describe('institution modules load in any order', () => {
  it('imports every plugin and registry module first in a fresh process without an initialisation error', async () => {
    const { spawnSync } = await import('node:child_process');
    const first = ['scripts/institutions/unimelb/index.mjs', 'scripts/institutions/unimelb/handbook-source.mjs', 'scripts/institutions/unimelb/handbook-parse.mjs',
      'scripts/institutions/registry.mjs', 'scripts/institutions/generic.mjs', 'scripts/lib/course-refs.mjs', 'scripts/lib/source-settings.mjs', 'scripts/sources/registry.mjs'];
    for (const module of first) {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(repo, module))});`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
      expect([run.status, run.stderr.trim()], module).toEqual([0, '']);
    }
  });
});
