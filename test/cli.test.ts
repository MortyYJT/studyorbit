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


it('generated root help advertises retained registry names', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const response = JSON.parse(result.stdout);
  expect(response).toMatchObject({ ok: true });
  expect(response.data.usage).toContain('courses');
});
it.each([['courses', 'list']].map(args => ({ args })))('unmounted $args remains discoverable and refuses safely without prompting', ({ args }) => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const help = spawnSync(process.execPath, [cli, ...args, '--help'], { encoding: 'utf8' });
  expect(JSON.parse(help.stdout)).toMatchObject({ ok: true, command: args.join('.') });
  const input = args[0] === 'courses' ? [] : ['--assessment-id', 'synthetic-assessment'];
  const result = spawnSync(process.execPath, [cli, ...args, ...input], { encoding: 'utf8', timeout: 5000 });
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, command: args.join('.') });
  expect(result.stderr).not.toMatch(/password|sign in:|RECORD|APPROVE/);
});

it('coursework mcp over real stdio pipes writes only MCP frames to stdout and exits when input ends', async () => {
  const { spawn } = await import('node:child_process');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const waitFor = async (id: number) => {
    for (let attempt = 0; attempt < 400 && !stdout.split('\n').some(line => line.includes(`"id":${id}`)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '0' } } });
  await waitFor(1);
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  await waitFor(2);
  send({ id: 3, method: 'tools/call', params: { name: 'policy.record', arguments: { owner: true } } });
  await waitFor(3);
  send({ id: 4, method: 'tools/call', params: { name: 'courses.list', arguments: {} } });
  await waitFor(4);
  child.stdin.end();
  expect(await exited).toBe(0);
  const frames = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  expect(frames.map(frame => frame.id)).toEqual([1, 2, 3, 4]);
  for (const frame of frames) expect(frame.jsonrpc).toBe('2.0');
  expect(frames[1]!.result.tools.length).toBe(12); // 14 retained registry commands minus 2 owner-only
  expect(JSON.parse(frames[2]!.result.content[0].text)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(JSON.parse(frames[3]!.result.content[0].text)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  expect(stderr).toContain('coursework mcp');
  expect(stderr).not.toMatch(/password|sign in:|RECORD|APPROVE/);
}, 20000);
