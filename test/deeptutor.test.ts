import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiCommand, assistantPorts, childEnv, createAssistant, disableWebSearch, guardEnv, installWarning, locateInstall, mergeMcpConfig, PROXY_TOKEN_ENV, proxyKey, restrictSystemSettings, setupProfile, webSearchOff } from '../scripts/lib/deeptutor.mjs';
import { closeServer, listen } from './local-api-helpers.ts';

// The assistant launcher (decisions #540-#549) against a stand-in DeepTutor: two Node scripts named `deeptutor` and
// `python` in a temporary "virtual environment". No real DeepTutor, no real model, no real key.
const SENTINEL = 'sk-sentinel-key-do-not-leak-0123456789';
let root: string, projectDir: string, bin: string, calls: string;
const servers: Server[] = [];
const freePort = async () => { const server = createServer(); const port = await listen(server); await closeServer(server); return port; };

const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ program: 'deeptutor', args, env: process.env, cwd: process.cwd() }) + '\\n');
const settings = path.join(process.env.DEEPTUTOR_HOME, 'data', 'user', 'settings');
if (args[0] === 'init') {
  if (process.env.FAKE_INIT_FAILS) process.exit(3);
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, 'system.json'), JSON.stringify({ version: 1, sandbox_allow_subprocess: true, version_check_enabled: true, backend_workers: 1 }));
  fs.writeFileSync(path.join(settings, 'main.yaml'), process.env.FAKE_YAML ?? 'tools:\\n  exec:\\n    allowed_roots:\\n    - ./data/user\\n  web_search:\\n    enabled: true\\n');
  fs.writeFileSync(path.join(settings, 'mcp.json'), JSON.stringify({ servers: { other: { url: 'http://127.0.0.1:1/mcp' } } }));
}
if (args[0] === 'config') fs.writeFileSync(path.join(settings, 'model_catalog.json'), JSON.stringify({ api_key: process.env.STUDYORBIT_LLM_PROXY_TOKEN, setup: JSON.parse(fs.readFileSync(args[2], 'utf8')) }));
`;
const FAKE_PYTHON = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ program: 'python', args, env: process.env, cwd: process.cwd() }) + '\\n');
if (args.includes('uvicorn')) {
  if (process.env.FAKE_API_FAILS) process.exit(4);
  const port = Number(args[args.indexOf('--port') + 1]);
  const skills = {};
  http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/health/ready') return res.end('{"status":"ready"}');
      if (req.url === '/studyorbit-guard/instance') return res.end(JSON.stringify({ instance: process.env.STUDYORBIT_GUARD_INSTANCE }));
      if (req.url === '/api/skills/studyorbit' && req.method === 'GET') { res.statusCode = skills.studyorbit ? 200 : 404; return res.end('{}'); }
      if (req.url.startsWith('/api/skills')) { skills.studyorbit = JSON.parse(body).content; fs.writeFileSync(path.join(process.env.DEEPTUTOR_HOME, 'skill.' + req.method + '.md'), skills.studyorbit); return res.end('{}'); }
      res.statusCode = 404; res.end();
    });
  }).listen(port, args[args.indexOf('--host') + 1]);
  process.on('SIGTERM', () => process.exit(0));
} else {
  const [, , home, port] = args;
  if (process.env.FAKE_PREPARE_SLOW) require('node:child_process').execFileSync('sleep', ['1.5']);
  const server = path.join(home, 'web-server.js');
  fs.writeFileSync(server, "require('node:fs').appendFileSync(process.env.DEEPTUTOR_HOME + '/web-env.json', JSON.stringify(process.env));require('node:http').createServer((q, s) => s.end('page')).listen(Number(process.env.PORT), process.env.HOSTNAME);process.on('SIGTERM', () => process.exit(0));");
  console.log('INFO something on stdout first');
  console.log(JSON.stringify({ server }));
}
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'so-assistant-'));
  projectDir = join(root, 'project');
  bin = join(root, 'venv', 'bin');
  calls = join(root, 'calls.jsonl');
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(root, 'venv', 'lib', 'python3.12', 'site-packages', 'deeptutor-1.7.4.dist-info'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'deeptutor'), FAKE_CLI); await chmod(join(bin, 'deeptutor'), 0o755);
  await writeFile(join(bin, 'python'), FAKE_PYTHON); await chmod(join(bin, 'python'), 0o755);
  await writeFile(calls, '');
});
afterEach(async () => { for (const server of servers.splice(0)) await closeServer(server); await rm(root, { recursive: true, force: true }); });

async function assistant(extraEnv: Record<string, string> = {}, options: Record<string, unknown> = {}) {
  const ports = { web: await freePort(), api: await freePort(), proxy: await freePort() };
  const proxies: { token: string; upstream: string; listened?: number; closed?: boolean }[] = [];
  const env = {
    PATH: process.env.PATH, HOME: root, DEEPSEEK_API_KEY: SENTINEL, STUDYORBIT_API_TOKEN: 'f'.repeat(64), HTTPS_PROXY: 'http://127.0.0.1:9',
    STUDYORBIT_DEEPTUTOR_BIN: join(bin, 'deeptutor'), STUDYORBIT_DEEPTUTOR_WEB_PORT: String(ports.web), STUDYORBIT_DEEPTUTOR_API_PORT: String(ports.api), STUDYORBIT_LLM_PROXY_PORT: String(ports.proxy),
    FAKE_CALLS: calls, ...extraEnv,
  };
  const lines: string[] = [];
  const instance = createAssistant({
    projectDir, webPort: 5999, env, home: root, log: line => lines.push(line), readyTimeoutMs: 8000, killAfterMs: 2000,
    createProxy: ({ token, upstream }) => { const entry: (typeof proxies)[number] = { token, upstream }; proxies.push(entry); return { listen: async port => { entry.listened = port; return port; }, close: async () => { entry.closed = true; } }; },
    // The stand-ins read FAKE_CALLS; everything else reaches them through the same allow-list as the real programs.
    spawn: ((command: string, args: string[], spawnOptions: { env: Record<string, string> }) => require('node:child_process').spawn(command, args, { ...spawnOptions, env: { ...spawnOptions.env, FAKE_CALLS: calls, ...Object.fromEntries(Object.entries(extraEnv).filter(([name]) => name.startsWith('FAKE_'))) } })) as never,
    ...options,
  });
  return { instance, ports, proxies, lines, env };
}
const recorded = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { program: string; args: string[]; env: Record<string, string>; cwd: string });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsOf = async () => (JSON.parse(await readFile(join(projectDir, '.local', 'deeptutor', 'processes.json'), 'utf8')) as { pid: number }[]).map(entry => entry.pid);
async function everyFile(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) out.push(...await everyFile(path)); else out.push(path); }
  return out;
}

describe('configuration', () => {
  it('uses one port set for the owner and another for every other instance, with overrides', () => {
    expect(assistantPorts({}, 5173)).toEqual({ web: 5175, api: 5195, proxy: 5197 });
    expect(assistantPorts({}, 5181)).toEqual({ web: 5185, api: 5196, proxy: 5199 });
    expect(assistantPorts({ STUDYORBIT_DEEPTUTOR_WEB_PORT: '6001', STUDYORBIT_LLM_PROXY_PORT: '6003' }, 5173)).toEqual({ web: 6001, api: 5195, proxy: 6003 });
    expect(() => assistantPorts({ STUDYORBIT_DEEPTUTOR_API_PORT: 'abc' }, 5173)).toThrow();
  });
  it('writes a setup profile that names the proxy and a token variable, never a key', () => {
    const profile = setupProfile({ model: 'deepseek-flash', ports: { web: 5185, api: 5196, proxy: 5199 } });
    expect(profile).toEqual({
      llm: { provider: 'deepseek', model: 'deepseek-flash', base_url: 'http://127.0.0.1:5199', api_key_env: PROXY_TOKEN_ENV, api_format: 'openai_responses' },
      search: { provider: 'none' }, system: { backend_port: 5196, frontend_port: 5185 },
    });
    expect(JSON.stringify(profile)).not.toMatch(/api_key"|sk-/);
  });
  it('registers the MCP server for this project and keeps other servers', () => {
    const merged = mergeMcpConfig({ servers: { other: { url: 'http://127.0.0.1:1/mcp' } } }, { node: '/n/node', projectDir: '/p', desktopDir: '/d' });
    expect(merged.servers.other).toEqual({ url: 'http://127.0.0.1:1/mcp' });
    expect(merged.servers.studyorbit).toMatchObject({ type: 'stdio', command: '/n/node', cwd: '/p' });
    // `--page-context`: only the MCP server DeepTutor starts reads the page context; other MCP clients are unchanged.
    expect(merged.servers.studyorbit.args).toEqual([fileURLToPath(new URL('../scripts/mcp-server.mjs', import.meta.url)), '--project', '/p', '--page-context', '--desktop', '/d']);
    expect(mergeMcpConfig('broken', { node: 'n', projectDir: '/p' }).servers.studyorbit.args).toHaveLength(4);
  });
  it('switches off local code execution, the update check and web search, leaving other settings', () => {
    expect(restrictSystemSettings({ backend_workers: 1, sandbox_allow_subprocess: true })).toEqual({ backend_workers: 1, sandbox_allow_subprocess: false, version_check_enabled: false });
    expect(disableWebSearch('tools:\n  exec:\n    x: true\n  web_search:\n    enabled: true\nother:\n  enabled: true\n')).toBe('tools:\n  exec:\n    x: true\n  web_search:\n    enabled: false\nother:\n  enabled: true\n');
    // `enabled` need not be the first key of the block, and may be missing or quoted.
    expect(disableWebSearch('tools:\n  web_search:\n    # a comment\n    provider: x\n    enabled:   yes  # on\n  exec:\n    enabled: true\n')).toBe('tools:\n  web_search:\n    # a comment\n    provider: x\n    enabled: false\n  exec:\n    enabled: true\n');
    expect(disableWebSearch('tools:\n  web_search:\n    provider: x\nlogging:\n  level: INFO\n')).toBe('tools:\n  web_search:\n    enabled: false\n    provider: x\nlogging:\n  level: INFO\n');
    for (const text of ['tools:\n  web_search:\n    enabled: true\n', 'tools:\n  web_search:\n    provider: x\n', 'tools:\n  web_search:\n    x: 1\n    enabled: "true"\n']) { expect(webSearchOff(text)).toBe(false); expect(webSearchOff(disableWebSearch(text))).toBe(true); }
    // No block, or a shape this code does not understand: left as it is and reported as not off.
    for (const text of ['tools:\n  exec:\n    x: 1\n', 'tools: { web_search: { enabled: true } }\n', 'tools:\n  web_search: {enabled: true}\n']) { expect(disableWebSearch(text)).toBe(text); expect(webSearchOff(text)).toBe(false); }
  });
  it('passes DeepTutor a short environment without keys, tokens or proxy settings', () => {
    expect(childEnv({ PATH: '/bin', HOME: '/h', DEEPSEEK_API_KEY: SENTINEL, ANTHROPIC_API_KEY: 'x', STUDYORBIT_API_TOKEN: 't', HTTPS_PROXY: 'p', NODE_DEBUG: 'http' }, { A: '1' })).toEqual({ PATH: '/bin', HOME: '/h', A: '1' });
  });
  it('binds the API to loopback behind the guard and allows only the two page origins', () => {
    const command = apiCommand({ python: '/v/bin/python', port: 5196 });
    expect(command.slice(0, 4)).toEqual(['/v/bin/python', '-m', 'uvicorn', 'guard_app:app']);
    expect(command[command.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(command).not.toContain('0.0.0.0');
    expect(guardEnv({ ports: { web: 5185, api: 5196, proxy: 5199 }, webPort: 5181 })).toEqual({
      STUDYORBIT_GUARD_PORTS: '5196,5185',
      STUDYORBIT_GUARD_ORIGINS: 'http://localhost:5185,http://127.0.0.1:5185,http://localhost:5181,http://127.0.0.1:5181',
    });
  });
  it('finds the install, its version and a solve module', async () => {
    expect(locateInstall({ STUDYORBIT_DEEPTUTOR_BIN: join(bin, 'deeptutor') })).toEqual({ bin: join(bin, 'deeptutor'), python: join(bin, 'python'), version: '1.7.4', solve: false });
    expect(locateInstall({}, join(root, 'nowhere'))).toBeNull();
    expect(installWarning({ bin: '', python: '', version: '1.7.4', solve: false })).toBeNull();
    expect(installWarning({ bin: '', python: '', version: '1.8.0', solve: false })).toBe('version');
    await mkdir(join(root, 'venv', 'lib', 'python3.12', 'site-packages', 'deeptutor_solve-1.7.4.dist-info'));
    expect(installWarning(locateInstall({ STUDYORBIT_DEEPTUTOR_BIN: join(bin, 'deeptutor') })!)).toBe('solve-module');
  });
});

describe('lifecycle', () => {
  it('reports not-installed and unsupported-provider without starting anything', async () => {
    const missing = await assistant({ STUDYORBIT_DEEPTUTOR_BIN: join(root, 'none', 'deeptutor') });
    await missing.instance.start();
    expect(missing.instance.status()).toEqual({ state: 'not-installed' });
    const other = await assistant({ COURSE_ANALYSIS_PROVIDER: 'anthropic' });
    await other.instance.start();
    expect(other.instance.status()).toEqual({ state: 'unsupported-provider' });
    expect(await recorded()).toEqual([]);
    expect(missing.proxies).toEqual([]);
    await missing.instance.stop(); await other.instance.stop();
  });

  it('configures and starts both processes on loopback, installs the house rules, and stops them', async () => {
    const { instance, ports, proxies, env } = await assistant();
    await instance.start();
    expect(instance.status()).toEqual({ state: 'running', url: `http://localhost:${ports.web}` });
    expect(proxies).toHaveLength(1);
    expect(proxies[0]).toMatchObject({ upstream: 'https://api.deepseek.com', listened: ports.proxy });
    expect(proxies[0]!.token).toMatch(/^[0-9a-f]{64}$/);

    const home = join(projectDir, '.local', 'deeptutor', 'home');
    const settings = join(home, 'data', 'user', 'settings');
    const log = await recorded();
    expect(log.map(entry => [entry.program, entry.args[0] === '-m' ? 'uvicorn' : entry.args[0]!.split('/').at(-1)])).toEqual([['deeptutor', 'init'], ['deeptutor', 'config'], ['python', 'uvicorn'], ['python', '-B']]);
    for (const entry of log) { expect(entry.env.DEEPTUTOR_HOME).toBe(home); expect(entry.env.HTTPS_PROXY).toBeUndefined(); }
    // DeepTutor's stored "key" is the launch token of the proxy.
    expect(JSON.parse(await readFile(join(settings, 'model_catalog.json'), 'utf8'))).toMatchObject({ api_key: proxies[0]!.token, setup: { llm: { base_url: `http://127.0.0.1:${ports.proxy}` } } });
    expect(JSON.parse(await readFile(join(settings, 'system.json'), 'utf8'))).toMatchObject({ sandbox_allow_subprocess: false, version_check_enabled: false, backend_workers: 1 });
    expect(await readFile(join(settings, 'main.yaml'), 'utf8')).toContain('web_search:\n    enabled: false');
    const mcp = JSON.parse(await readFile(join(settings, 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.servers)).toEqual(['other', 'studyorbit']);
    expect(mcp.servers.studyorbit.args.slice(1)).toEqual(['--project', projectDir, '--page-context']);
    const api = log[2]!;
    expect(api.args[api.args.indexOf('--host') + 1]).toBe('127.0.0.1');
    const instanceId = (await readFile(join(projectDir, '.local', 'deeptutor', 'instance-id'), 'utf8')).trim();
    expect(instanceId).toMatch(/^[0-9a-f]{32}$/);
    expect(api.env).toMatchObject({ DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS: '0', STUDYORBIT_GUARD_PORTS: `${ports.api},${ports.web}`, STUDYORBIT_GUARD_INSTANCE: instanceId });
    expect(JSON.parse(await readFile(join(home, 'web-env.json'), 'utf8'))).toMatchObject({ HOSTNAME: '127.0.0.1', PORT: String(ports.web), DEEPTUTOR_API_BASE_URL: `http://127.0.0.1:${ports.api}` });
    expect(await readFile(join(home, 'skill.POST.md'), 'utf8')).toBe(await readFile(fileURLToPath(new URL('../scripts/deeptutor/skill/SKILL.md', import.meta.url)), 'utf8'));

    // The key is in no generated file, no argument and no child environment.
    for (const file of await everyFile(root)) expect(await readFile(file, 'utf8'), file).not.toContain(SENTINEL);
    expect(env.DEEPSEEK_API_KEY).toBe(SENTINEL);

    const pids = await pidsOf();
    expect(pids.every(alive)).toBe(true);
    await instance.stop();
    expect(pids.some(alive)).toBe(false);
    expect(proxies[0]!.closed).toBe(true);
  });

  it('adopts a healthy DeepTutor only when it proves to be this project\'s guarded instance, and never stops it', async () => {
    await mkdir(join(projectDir, '.local', 'deeptutor'), { recursive: true });
    await writeFile(join(projectDir, '.local', 'deeptutor', 'instance-id'), 'c'.repeat(32));
    const { instance, ports, proxies } = await assistant();
    const external = createServer((req, res) => res.end(req.url === '/studyorbit-guard/instance' ? JSON.stringify({ instance: 'c'.repeat(32) }) : '{"status":"ready"}'));
    servers.push(external);
    await new Promise<void>(resolve => external.listen(ports.api, '127.0.0.1', resolve));
    await instance.start();
    expect(instance.status()).toEqual({ state: 'external', url: `http://localhost:${ports.web}` });
    expect(await recorded()).toEqual([]);
    expect(proxies).toEqual([]);
    await instance.stop();
    expect(external.listening).toBe(true);
  });

  it('refuses a healthy DeepTutor on its port that is unguarded or belongs to another checkout', async () => {
    for (const answer of ['{"status":"ready"}', JSON.stringify({ instance: 'd'.repeat(32) })]) {
      const { instance, ports, proxies } = await assistant();
      const other = createServer((req, res) => res.end(answer));
      servers.push(other);
      await new Promise<void>(resolve => other.listen(ports.api, '127.0.0.1', resolve));
      await instance.start();
      expect(instance.status()).toEqual({ state: 'failed', reason: `port ${ports.api} is in use by another DeepTutor or program` });
      expect(await recorded()).toEqual([]);
      expect(proxies).toEqual([]);
      await instance.stop();
      expect(other.listening).toBe(true);
    }
  });

  it('records each process as soon as it is launched, so a killed server leaves nothing unrecorded', async () => {
    const { instance } = await assistant({ FAKE_PREPARE_SLOW: '1' });
    const starting = instance.start();
    // While the web files are still being prepared the API is already running and already on record.
    let early: number[] = [];
    for (let waited = 0; waited < 100 && early.length === 0; waited += 1) { early = await pidsOf().catch(() => []); if (!early.length) await new Promise(resolve => setTimeout(resolve, 50)); }
    expect(instance.status().state).toBe('starting');
    expect(early).toHaveLength(1);
    expect(alive(early[0]!)).toBe(true);
    await starting;
    expect(await pidsOf()).toHaveLength(2);
    await instance.stop();
  });

  it('a stop during start-up leaves no process and no open proxy, at whatever step it arrives', async () => {
    for (const delay of [0, 30, 150, 400, 900]) {
      const { instance, proxies } = await assistant({ FAKE_PREPARE_SLOW: '1' });
      const starting = instance.start();
      await new Promise(resolve => setTimeout(resolve, delay));
      const early = await pidsOf().catch(() => []);
      await instance.stop();
      await starting;
      expect(instance.status().state, `delay ${delay}`).not.toBe('running');
      expect(proxies.every(proxy => proxy.closed || proxy.listened === undefined), `delay ${delay}`).toBe(true);
      expect(early.some(alive), `delay ${delay}`).toBe(false);
      expect(await pidsOf().catch(() => []), `delay ${delay}`).toEqual([]);
    }
  }, 30000);

  it('fails loudly when web search cannot be switched off in main.yaml', async () => {
    const { instance, proxies } = await assistant({ FAKE_YAML: 'tools: { web_search: { enabled: true } }\n' });
    await instance.start();
    expect(instance.status()).toEqual({ state: 'failed', reason: 'web search could not be switched off in DeepTutor\'s main.yaml' });
    expect((await recorded()).map(entry => entry.program)).toEqual(['deeptutor', 'deeptutor']);
    expect(proxies[0]!.closed).toBe(true);
    await instance.stop();
  });

  it('turns a failed set-up step or a failed start into a status and leaves nothing running', async () => {
    const init = await assistant({ FAKE_INIT_FAILS: '1' });
    await init.instance.start();
    expect(init.instance.status()).toEqual({ state: 'failed', reason: 'deeptutor init failed (exit 3)' });
    expect(init.proxies[0]!.closed).toBe(true);
    await init.instance.stop();
    const api = await assistant({ FAKE_API_FAILS: '1' });
    await api.instance.start();
    expect(api.instance.status()).toMatchObject({ state: 'failed' });
    expect((api.instance.status() as { reason: string }).reason).toMatch(/API/);
    await api.instance.stop();
    expect(api.proxies[0]!.closed).toBe(true);
  });

  it('reports a DeepTutor process that exits later, stops the other one and closes the proxy', async () => {
    const { instance, proxies } = await assistant();
    await instance.start();
    const [apiPid, webPid] = await pidsOf();
    process.kill(apiPid!, 'SIGKILL');
    for (let waited = 0; waited < 100 && (instance.status().state === 'running' || alive(webPid!)); waited += 1) await new Promise(resolve => setTimeout(resolve, 50));
    expect(instance.status()).toEqual({ state: 'failed', reason: 'DeepTutor API exited' });
    expect(alive(webPid!)).toBe(false);
    for (let waited = 0; waited < 100 && !proxies[0]!.closed; waited += 1) await new Promise(resolve => setTimeout(resolve, 50));
    expect(proxies[0]!.closed).toBe(true);
    await instance.stop();
  });

  it('stops processes left by a server that was killed, recognised by their command line', async () => {
    const first = await assistant();
    await first.instance.start();
    const pids = await pidsOf();
    // The first server "dies" without stopping anything; a new one for the same project starts on other ports.
    const second = await assistant();
    await second.instance.start();
    expect(pids.some(alive)).toBe(false);
    expect(second.instance.status().state).toBe('running');
    // A recorded PID whose command line does not match (a recycled PID) is left alone.
    await second.instance.stop();
    await mkdir(join(projectDir, '.local', 'deeptutor'), { recursive: true });
    await writeFile(join(projectDir, '.local', 'deeptutor', 'processes.json'), JSON.stringify([{ pid: process.pid, marker: 'guard_app:app' }]));
    const third = await assistant();
    await third.instance.start();
    expect(alive(process.pid)).toBe(true);
    await third.instance.stop();
    await first.instance.stop();
  }, 30000);
});

describe('proxyKey', () => {
  // Two different sentinel keys: the key handed to the DeepSeek proxy must never be another provider's.
  const DEEPSEEK = 'sk-deepseek-sentinel-000', OTHER = 'sk-other-provider-sentinel-999';
  const save = async (config: Record<string, unknown>) => { await mkdir(join(projectDir, '.local', 'config'), { recursive: true }); await writeFile(join(projectDir, '.local', 'config', 'llm.json'), JSON.stringify({ updatedAt: '2026-11-24T00:00:00.000Z', ...config })); };

  it('returns the DeepSeek key from the environment or the settings', async () => {
    expect(await proxyKey(projectDir, { DEEPSEEK_API_KEY: DEEPSEEK })).toBe(DEEPSEEK);
    await save({ provider: 'deepseek', apiKey: DEEPSEEK });
    expect(await proxyKey(projectDir, {})).toBe(DEEPSEEK);
    expect(await proxyKey(projectDir, { ANTHROPIC_API_KEY: OTHER })).toBe(DEEPSEEK);
  });
  it('returns nothing once the settings name another provider, whatever keys exist', async () => {
    await save({ provider: 'anthropic', apiKey: OTHER });
    expect(await proxyKey(projectDir, { DEEPSEEK_API_KEY: DEEPSEEK })).toBeNull();
    await save({ provider: 'openai-compatible', apiKey: OTHER, baseUrl: 'https://api.example.com/v1/chat/completions', model: 'm' });
    expect(await proxyKey(projectDir, { DEEPSEEK_API_KEY: DEEPSEEK })).toBeNull();
    await save({ provider: 'codex' });
    expect(await proxyKey(projectDir, { DEEPSEEK_API_KEY: DEEPSEEK })).toBeNull();
  });
  it('returns nothing for another provider chosen through the environment, or with no key at all', async () => {
    expect(await proxyKey(projectDir, { COURSE_ANALYSIS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: OTHER, DEEPSEEK_API_KEY: DEEPSEEK })).toBeNull();
    expect(await proxyKey(projectDir, { COURSE_ANALYSIS_PROVIDER: 'openai-compatible', COURSE_ANALYSIS_URL: 'https://api.example.com/v1', COURSE_ANALYSIS_API_KEY: OTHER })).toBeNull();
    expect(await proxyKey(projectDir, { COURSE_ANALYSIS_PROVIDER: 'nonsense', DEEPSEEK_API_KEY: DEEPSEEK })).toBeNull();
    expect(await proxyKey(projectDir, {})).toBeNull();
  });
});

describe('startTurn', () => {
  class FakeSocket extends EventTarget {
    static sent: string[] = [];
    static script: (socket: FakeSocket) => void = () => {};
    closed = false;
    url: string;
    constructor(url: string) { super(); this.url = url; queueMicrotask(() => { this.dispatchEvent(new Event('open')); FakeSocket.script(this); }); }
    send(data: string) { FakeSocket.sent.push(data); }
    close() { this.closed = true; }
    reply(value: unknown) { const event = new Event('message') as Event & { data: string }; event.data = JSON.stringify(value); this.dispatchEvent(event); }
  }
  const make = async () => { FakeSocket.sent = []; const { instance, ports } = await assistant({ STUDYORBIT_DEEPTUTOR_BIN: join(root, 'none') }, { WebSocketImpl: FakeSocket, turnTimeoutMs: 200 }); await instance.start(); return { instance, ports }; };

  it('sends one start_turn with protocol 2.0 and no optional tools, and resolves with the session id', async () => {
    let socket!: FakeSocket;
    FakeSocket.script = created => { socket = created; created.reply({ type: 'session', session_id: 'unified_1_abc' }); };
    const { instance, ports } = await make();
    expect(await instance.startTurn({ content: 'Help me revise', language: 'en' })).toEqual({ sessionId: 'unified_1_abc' });
    expect(socket.url).toBe(`ws://127.0.0.1:${ports.api}/ws`);
    expect(FakeSocket.sent.map(text => JSON.parse(text))).toEqual([{ type: 'start_turn', protocol_version: '2.0', capability: 'chat', content: 'Help me revise', language: 'en', tools: [] }]);
    expect(socket.closed).toBe(true);
  });
  it('rejects on a protocol error and on silence', async () => {
    FakeSocket.script = created => created.reply({ type: 'protocol_error', error_code: 'unsupported_protocol_version' });
    const { instance } = await make();
    await expect(instance.startTurn({ content: 'x', language: 'zh' })).rejects.toThrow(/unsupported_protocol_version/);
    FakeSocket.script = () => {};
    await expect(instance.startTurn({ content: 'x', language: 'zh' })).rejects.toThrow(/in time/);
  });
});

describe('guard_app.py', () => {
  // The pure check and the ASGI wrapper, run with the system Python (the real one runs inside DeepTutor's interpreter).
  it('refuses foreign hosts, origins and cross-site requests for HTTP and WebSocket and passes the rest through', () => {
    const script = `
import asyncio, json, os, sys
os.environ["STUDYORBIT_GUARD_SKIP_APP"] = "1"
sys.path.insert(0, sys.argv[1])
import guard_app as g
hosts = g.allowed_hosts(frozenset({"5196", "5185"})); origins = frozenset({"http://localhost:5185", "http://localhost:5181"})
INSTANCE = "abc123"
cases = {
  "ok": {"host": "127.0.0.1:5196"}, "ok-web-host": {"host": "localhost:5185"}, "ok-ipv6": {"host": "[::1]:5196"},
  "ok-origin": {"host": "127.0.0.1:5196", "origin": "http://localhost:5181", "sec-fetch-site": "same-site"},
  "ok-forwarded": {"host": "127.0.0.1:5196", "x-forwarded-host": "localhost:5185", "x-deeptutor-frontend-host": "localhost:5185"},
  "no-host": {}, "evil-host": {"host": "evil.example:5196"}, "wrong-port": {"host": "localhost:9999"}, "bare-host": {"host": "localhost"},
  "evil-origin": {"host": "127.0.0.1:5196", "origin": "https://evil.example"}, "null-origin": {"host": "127.0.0.1:5196", "origin": "null"},
  "cross-site": {"host": "127.0.0.1:5196", "sec-fetch-site": "Cross-Site"},
  "rebinding-through-web": {"host": "127.0.0.1:5196", "x-forwarded-host": "evil.example:5185"},
  "rebinding-frontend-header": {"host": "127.0.0.1:5196", "x-deeptutor-frontend-host": "evil.example:5185"},
}
out = {name: g.allowed(headers, hosts, origins) for name, headers in cases.items()}
async def drive(kind, headers, path="/x"):
    sent, reached = [], []
    async def inner(scope, receive, send): reached.append(scope["type"])
    async def send(message): sent.append(message)
    await g.guard(inner, hosts, origins, INSTANCE)({"type": kind, "path": path, "method": "GET", "headers": headers}, None, send)
    return {"reached": reached, "sent": [m.get("status", m.get("code", m["type"])) for m in sent], "body": b"".join(m.get("body", b"") for m in sent).decode()}
out["asgi"] = {
  "http-ok": asyncio.run(drive("http", [(b"host", b"127.0.0.1:5196")])),
  "http-evil": asyncio.run(drive("http", [(b"host", b"127.0.0.1:5196"), (b"origin", b"https://evil.example")])),
  "ws-evil": asyncio.run(drive("websocket", [(b"host", b"127.0.0.1:5196"), (b"origin", b"https://evil.example")])),
  "ws-ok": asyncio.run(drive("websocket", [(b"host", b"127.0.0.1:5196")])),
  "two-hosts": asyncio.run(drive("http", [(b"host", b"127.0.0.1:5196"), (b"host", b"evil.example")])),
  "lifespan": asyncio.run(drive("lifespan", [])),
  "instance": asyncio.run(drive("http", [(b"host", b"127.0.0.1:5196")], "/studyorbit-guard/instance")),
  "instance-evil": asyncio.run(drive("http", [(b"host", b"127.0.0.1:5196"), (b"origin", b"https://evil.example")], "/studyorbit-guard/instance")),
}
print(json.dumps(out))
`;
    const dir = fileURLToPath(new URL('../scripts/deeptutor/', import.meta.url));
    const out = JSON.parse(execFileSync('python3', ['-B', '-c', script, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').at(-1)!);
    const { asgi, ...checks } = out;
    expect(checks).toEqual({
      ok: null, 'ok-web-host': null, 'ok-ipv6': null, 'ok-origin': null, 'ok-forwarded': null,
      'no-host': 'host', 'evil-host': 'host', 'wrong-port': 'host', 'bare-host': 'host', 'evil-origin': 'origin', 'null-origin': 'origin', 'cross-site': 'cross-site',
      'rebinding-through-web': 'forwarded-host', 'rebinding-frontend-header': 'forwarded-host',
    });
    expect(asgi).toEqual({
      'http-ok': { reached: ['http'], sent: [], body: '' }, 'http-evil': { reached: [], sent: [403, 'http.response.body'], body: '' },
      'ws-evil': { reached: [], sent: [1008], body: '' }, 'ws-ok': { reached: ['websocket'], sent: [], body: '' },
      'two-hosts': { reached: [], sent: [403, 'http.response.body'], body: '' }, lifespan: { reached: ['lifespan'], sent: [], body: '' },
      // The guard itself answers who it is (never DeepTutor), and only to callers that pass the same checks.
      instance: { reached: [], sent: [200, 'http.response.body'], body: '{"instance": "abc123"}' },
      'instance-evil': { reached: [], sent: [403, 'http.response.body'], body: '' },
    });
  });
});
