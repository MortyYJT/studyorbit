#!/usr/bin/env node
// Fake `codex` for adapter tests: replays a scripted run and records argv, cwd, env, stdin and the workspace AGENTS.md.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = dirname(process.argv[1]);
const calls = join(dir, 'calls.jsonl');
const index = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0;
const runs = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
const run = runs[Math.min(index, runs.length - 1)];
const agents = existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : null;
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  appendFileSync(calls, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin, agents, pid: process.pid })}\n`);
  const lines = run.fixture ? readFileSync(run.fixture, 'utf8').split('\n').filter(Boolean) : run.stdout ?? [];
  for (const line of lines) process.stdout.write(`${line}\n`);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.hang) {
    process.on('SIGTERM', () => appendFileSync(join(dir, 'signals'), 'TERM\n'));
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = run.exit ?? 0;
});
