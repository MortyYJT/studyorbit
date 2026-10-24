import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, beforeEach, afterEach, expect, it } from 'vitest';

let home: string; let previousHome: string | undefined;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'coursework-cli-'))); previousHome = process.env.COURSEWORK_HOME; process.env.COURSEWORK_HOME = home; });
afterEach(() => { if (previousHome === undefined) delete process.env.COURSEWORK_HOME; else process.env.COURSEWORK_HOME = previousHome; rmSync(home, { recursive: true, force: true }); });

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
it.each([['courses', 'list']].map(args => ({ args })))('production $args reads SQLite safely without prompting', ({ args }) => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const help = spawnSync(process.execPath, [cli, ...args, '--help'], { encoding: 'utf8' });
  expect(JSON.parse(help.stdout)).toMatchObject({ ok: true, command: args.join('.') });
  const input = args[0] === 'courses' ? [] : ['--assessment-id', 'synthetic-assessment'];
  const result = spawnSync(process.execPath, [cli, ...args, ...input], { encoding: 'utf8', timeout: 5000 });
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: args.join('.'), data: { items: [] } });
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
  // 30 agent commands (incl. metrics.read, autonomy.read, source.record and, from agent-course-reading, courses.offer, courses.candidates
  // and course.import); codex-browser-cleanup removed source.fetch, browser.status and the seven browser tools; long-term-memory
  // added memory.record and memory.list (32); owner commands (incl. courses.select and memory.add/edit/delete) remain excluded.
  expect(frames[1]!.result.tools.length).toBe(32);
  expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['memory.record', 'memory.list']));
  expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('memory.delete');
  expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['courses.offer', 'courses.candidates', 'course.import']));
  expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('courses.select');
  expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).toContain('source.record');
  expect(frames[1]!.result.tools.some((tool: { name: string }) => tool.name.startsWith('browser.'))).toBe(false);
  expect(frames[1]!.result.tools.map((tool: { name: string }) => tool.name)).toContain('metrics.read');
  expect(JSON.parse(frames[2]!.result.content[0].text)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(JSON.parse(frames[3]!.result.content[0].text)).toMatchObject({ ok: true, data: { items: [] } });
  expect(stderr).toContain('coursework mcp');
  expect(stderr).not.toMatch(/password|sign in:|RECORD|APPROVE/);
}, 20000);

it('coursework mcp attributes memory.record to COURSEWORK_CONVERSATION_ID; without it the memory has no source', async () => {
  const { spawn } = await import('node:child_process');
  const { SqliteRepository } = await import('../src/store/sqlite.js');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const record = async (env: Record<string, string>, text: string) => {
    const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const waitFor = async (id: number) => {
      for (let attempt = 0; attempt < 400 && !stdout.split('\n').some(line => line.includes(`"id":${id}`)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    };
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '0' } } });
    await waitFor(1); send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'memory.record', arguments: { kind: 'habit', text } } });
    await waitFor(2); child.stdin.end();
    expect(await exited).toBe(0);
    const frame = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(value => value.id === 2);
    expect(JSON.parse(frame.result.content[0].text)).toMatchObject({ ok: true });
  };
  await record({ COURSEWORK_CONVERSATION_ID: 'v-env' }, 'Reviews notes before class');
  await record({}, 'Works in short sessions');
  const store = new SqliteRepository(join(home, 'coursework.db'));
  try {
    const rows = store.listMemories();
    expect(rows.find(row => row.text === 'Reviews notes before class')).toMatchObject({ origin: 'agent', conversationId: 'v-env' });
    expect(rows.find(row => row.text === 'Works in short sessions')).not.toHaveProperty('conversationId');
  } finally { store.close(); }
}, 20000);

it('production initialization failures print one safe CLI envelope', () => {
  const blocked = join(home, 'blocked'); writeFileSync(blocked, 'synthetic');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'courses', 'list', '--json'], {
    encoding: 'utf8', env: { ...process.env, COURSEWORK_HOME: blocked }, timeout: 5000,
  });
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(result.stdout + result.stderr).not.toContain(blocked);
});
it('invalid MCP invocation remains a CLI call with one refusal envelope', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'mcp', '--invalid'], { encoding: 'utf8', timeout: 5000 });
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
});
