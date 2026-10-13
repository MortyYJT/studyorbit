import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpChild } from './mcp-child.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

it('MCP production import graph has a cheap heuristic guard for obvious direct stdout access', async () => {
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return; visited.add(path);
    const code = await readFile(path, 'utf8');
    if (!path.endsWith('/protocol/mcp.ts')) {
      // Console output is redirected by the executable. Direct stream/fd writes bypass that redirect.
      expect(code, path).not.toMatch(/process(?:\s*\.\s*stdout|\[['"]stdout['"]\])|(?:write|writeSync)\s*\(\s*1\s*[,)]|(?:import|require).*\bstdout\b.*(?:node:process|['"]process['"])/);
    }
    const imports = [...code.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+\.js)['"]/g)];
    for (const match of imports) await visit(resolve(dirname(path), match[1]!.replace(/\.js$/, '.ts')));
  }
  await visit(resolve('src/protocol/production.ts'));
  await visit(resolve('src/protocol/mcp.ts'));
  expect(visited.size).toBeGreaterThan(20);
});

let home: string;
let previousHome: string | undefined;
beforeAll(async () => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
  home = await realpath(await mkdtemp(join(tmpdir(), 'mcp-framing-')));
  previousHome = process.env.COURSEWORK_HOME; process.env.COURSEWORK_HOME = home;
});
afterAll(async () => {
  if (previousHome === undefined) delete process.env.COURSEWORK_HOME; else process.env.COURSEWORK_HOME = previousHome;
  if (home) await rm(home, { recursive: true, force: true });
});
it('real child framing check rejects direct FD alias pollution that bypasses the static scan', async () => {
  await expect(mcpChild("import { writeSync } from 'node:fs'; const fd = 1; writeSync(fd, 'synthetic stdout pollution\\n');"))
    .rejects.toThrow('Invalid MCP stdout frame');
}, 20000);

it('production MCP reads SQLite through clean executable stdout', async () => { await mcpChild(); }, 20000);
