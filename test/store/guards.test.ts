import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { sqliteImports } from './import-guard.js';

it('detects static, re-export, dynamic, CommonJS and type-only SQLite imports', () => {
  for (const source of [
    "import { DatabaseSync } from 'node:sqlite';",
    "import type { DatabaseSync } from 'node:sqlite';",
    "export { DatabaseSync } from 'node:sqlite';",
    "export * from 'node:sqlite';",
    "const sqlite = await import('node:sqlite');",
    "const sqlite = require('node:sqlite');",
    "import sqlite = require('node:sqlite');",
    'const text = `db: ${await import("node:sqlite")}`;',
    String.raw`const apostrophe = /'/; const sqlite = await import('node:sqlite');`,
    'const backtick = /`/; const sqlite = await import("node:sqlite");',
    String.raw`const slash = /[\/']/; const sqlite = await import('node:sqlite');`,
    'const text = `db: ${/}/.test("}") ? import("node:sqlite") : null}`;',
    'const ratio = 10 / await import("node:sqlite") / 2;',
    'const text = `db: ${ { db: import("node:sqlite") } }`;',
    String.raw`import sqlite from 'node:\x73qlite';`,
    String.raw`const sqlite = import('node:\u0073qlite');`,
  ]) expect(sqliteImports(source)).toEqual([1]);
  expect(sqliteImports("// import 'node:sqlite'\nconst example = \"import 'node:sqlite'\";")).toEqual([]);
});

it('keeps SQL imports inside src/store across tracked and new source files', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0').filter(file => file && existsSync(file) && /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('src/store/'));
  const violations = files.flatMap(file => sqliteImports(readFileSync(file, 'utf8')).map(line => `${file}:${line}`));
  expect(violations).toEqual([]);
});

it('confirms git ignores the local database', () => {
  const ignored = execFileSync('git', ['check-ignore', '.local/coursework.db'], { encoding: 'utf8' }).trim();
  expect(ignored).toBe('.local/coursework.db');
});
