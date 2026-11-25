// The assistant: DeepTutor (HKUDS/DeepTutor) started next to the local API server (decisions #540-#549).
// StudyOrbit does not chat itself any more; it installs nothing into the repository, generates DeepTutor's
// configuration (never containing the model key), starts DeepTutor's API behind `scripts/deeptutor/guard_app.py` and
// its packaged web server, both bound to 127.0.0.1, and stops what it started. Nothing here may fail the server:
// every problem becomes a status the Agent page shows.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAnalysisConfig } from './llm-config.mjs';

/** The DeepTutor release this integration was written and tried against. Other 1.7.x releases start with a warning. */
export const DEEPTUTOR_VERSION = '1.7.4';
export const DEEPSEEK_UPSTREAM = 'https://api.deepseek.com';
/** Name of the variable `deeptutor config apply` reads; it holds the launch token of the model proxy, not a key. */
export const PROXY_TOKEN_ENV = 'STUDYORBIT_LLM_PROXY_TOKEN';
const SCRIPTS = fileURLToPath(new URL('../deeptutor/', import.meta.url));
const MCP_SCRIPT = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));
const OWNER_PORTS = { web: 5175, api: 5195, proxy: 5197 };
const TEST_PORTS = { web: 5185, api: 5196, proxy: 5199 };

function port(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} 不是有效端口：${value}`);
  return Number(value);
}

/**
 * Ports of DeepTutor's web server, its API and the model proxy. The owner's instance (page on 5173) and every other
 * instance get different fixed sets, so a test run can never talk to the owner's DeepTutor; each can be overridden.
 * @param {Record<string, string | undefined>} env
 * @param {number} webPort the StudyOrbit page's port
 */
export function assistantPorts(env, webPort) {
  const base = webPort === 5173 ? OWNER_PORTS : TEST_PORTS;
  return {
    web: port(env, 'STUDYORBIT_DEEPTUTOR_WEB_PORT', base.web),
    api: port(env, 'STUDYORBIT_DEEPTUTOR_API_PORT', base.api),
    proxy: port(env, 'STUDYORBIT_LLM_PROXY_PORT', base.proxy),
  };
}

/**
 * The installed DeepTutor: `STUDYORBIT_DEEPTUTOR_BIN` or the default virtual environment in the user's home. Returns
 * the CLI, the interpreter next to it, the installed version and whether the solve module is present; null when the
 * CLI or the interpreter is missing.
 * @param {Record<string, string | undefined>} env
 * @param {string} [home]
 */
export function locateInstall(env, home = homedir()) {
  const bin = env.STUDYORBIT_DEEPTUTOR_BIN || join(home, '.local', 'share', 'studyorbit', 'deeptutor', 'venv', 'bin', 'deeptutor');
  const python = join(dirname(bin), 'python');
  if (!existsSync(bin) || !existsSync(python)) return null;
  let version = null, solve = false;
  try {
    const lib = join(dirname(dirname(bin)), 'lib');
    for (const folder of readdirSync(lib)) {
      for (const entry of readdirSync(join(lib, folder, 'site-packages'))) {
        const core = /^deeptutor-(\d+\.\d+\.\d+)\.dist-info$/.exec(entry);
        if (core) version = core[1];
        if (/^deeptutor_solve-.*\.dist-info$/.test(entry)) solve = true;
      }
    }
  } catch { /* An unusual layout: the version stays unknown and start-up decides. */ }
  return { bin, python, version, solve };
}

/** A note for the Agent page about the installation, or null. */
export function installWarning(install) {
  if (install.solve) return 'solve-module';
  if (install.version && install.version !== DEEPTUTOR_VERSION) return 'version';
  return null;
}

/**
 * The setup profile for `deeptutor config apply`. It names the proxy as the endpoint and a variable holding the launch
 * token; the key itself is never part of it. DeepSeek uses the Responses format: with chat-completions DeepTutor 1.7.4
 * drops an empty `reasoning_content` and DeepSeek rejects the next tool round (decision #543).
 * @param {{ model: string, ports: { web: number, api: number, proxy: number } }} options
 */
export function setupProfile({ model, ports }) {
  return {
    llm: { provider: 'deepseek', model, base_url: `http://127.0.0.1:${ports.proxy}`, api_key_env: PROXY_TOKEN_ENV, api_format: 'openai_responses' },
    search: { provider: 'none' },
    system: { backend_port: ports.api, frontend_port: ports.web },
  };
}

/**
 * DeepTutor's MCP registry with the `studyorbit` stdio server pointing at this project; other servers are kept.
 * @param {unknown} existing parsed `mcp.json`, or anything else when there is none
 * @param {{ node: string, projectDir: string, desktopDir?: string }} options
 */
export function mergeMcpConfig(existing, { node, projectDir, desktopDir }) {
  const servers = existing && typeof existing === 'object' && existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers) ? existing.servers : {};
  return { servers: { ...servers, studyorbit: {
    type: 'stdio', command: node,
    // `--page-context`: only this MCP server, the one DeepTutor starts, reads what the Agent page saved (decision #546).
    args: [MCP_SCRIPT, '--project', projectDir, '--page-context', ...(desktopDir ? ['--desktop', desktopDir] : [])],
    cwd: projectDir, tool_timeout: 30, enabled: true,
  } } };
}

/** `system.json` with local code execution and the update check switched off (decision #545); other keys are kept. */
export function restrictSystemSettings(existing) {
  return { ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}), sandbox_allow_subprocess: false, version_check_enabled: false };
}

/**
 * Where `enabled` of the block-style `web_search:` mapping is in `main.yaml`: the line index of `web_search:`, its
 * indentation, and the index and value of its own `enabled:` line (null when the block has none). Null when there is
 * no such block or it is written in a form this does not read (flow style `{...}`), so callers can refuse to guess.
 */
function webSearchBlock(lines) {
  const start = lines.findIndex(line => /^\s+web_search:\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  let childIndent = null, enabledAt = null, value = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const depth = line.match(/^\s*/)[0].length;
    if (depth <= indent) break;
    childIndent ??= depth;
    const match = depth === childIndent ? /^\s*enabled:\s*(.*?)\s*(#.*)?$/.exec(line) : null;
    if (match) { enabledAt = index; value = match[1].replace(/^["']|["']$/g, '').toLowerCase(); }
  }
  return { start, indent, childIndent: childIndent ?? indent + 2, enabledAt, value };
}

/** True only when `main.yaml` has a block-style `web_search:` whose `enabled` is written as false. */
export function webSearchOff(yaml) {
  const block = webSearchBlock(yaml.split('\n'));
  return !!block && block.enabledAt !== null && ['false', 'no', 'off'].includes(block.value);
}

/**
 * `main.yaml` with `web_search.enabled` set to false: the block's own `enabled` line is rewritten wherever it stands,
 * or added as the block's first key. The file is DeepTutor's and nothing else in it changes. Text without a readable
 * `web_search:` block is returned unchanged; `webSearchOff` then says so and the launcher refuses to start.
 */
export function disableWebSearch(yaml) {
  const lines = yaml.split('\n');
  const block = webSearchBlock(lines);
  if (!block) return yaml;
  const line = `${' '.repeat(block.childIndent)}enabled: false`;
  if (block.enabledAt === null) lines.splice(block.start + 1, 0, line); else lines[block.enabledAt] = line;
  return lines.join('\n');
}

/**
 * The key the model proxy may add (decision #542): the DeepSeek key, and only while the model settings still resolve
 * to DeepSeek. The settings are read on every request, so when the owner switches to another provider while DeepTutor
 * runs, that provider's key is never sent to DeepSeek's address: the proxy answers 503 instead.
 * @param {string} projectDir
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<string | null>}
 */
export async function proxyKey(projectDir, env) {
  const config = await resolveAnalysisConfig(projectDir, env);
  return config.provider === 'deepseek' && !config.invalidProvider ? config.apiKey ?? null : null;
}

const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM'];
/**
 * Environment for a DeepTutor process: a short allow-list plus `extra`. Model keys, the API token and proxy settings
 * of the parent are not passed on; DeepTutor reaches the model only through the loopback proxy.
 */
export function childEnv(env, extra = {}) {
  return { ...Object.fromEntries(PASSED_ENV.filter(name => env[name] !== undefined).map(name => [name, env[name]])), ...extra };
}

/** Command line of DeepTutor's API behind the guard, bound to loopback. */
export function apiCommand({ python, port: apiPort }) {
  return [python, '-m', 'uvicorn', 'guard_app:app', '--app-dir', SCRIPTS.replace(/\/$/, ''), '--host', '127.0.0.1', '--port', String(apiPort),
    '--no-proxy-headers', '--no-access-log', '--workers', '1', '--timeout-graceful-shutdown', '1'];
}

/** Origins the guard accepts: DeepTutor's own page and the StudyOrbit page, under both loopback names. */
export function guardEnv({ ports, webPort, instance }) {
  return {
    ...(instance ? { STUDYORBIT_GUARD_INSTANCE: instance } : {}),
    STUDYORBIT_GUARD_PORTS: `${ports.api},${ports.web}`,
    STUDYORBIT_GUARD_ORIGINS: [ports.web, webPort].flatMap(value => [`http://localhost:${value}`, `http://127.0.0.1:${value}`]).join(','),
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }
async function writePrivate(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

/**
 * @typedef {{ state: 'off' | 'starting' | 'not-installed' | 'unsupported-provider' } | { state: 'running' | 'external', url: string, warning?: string } | { state: 'failed', reason: string }} AssistantStatus
 */

/**
 * The assistant of one StudyOrbit instance. `start()` never rejects and returns when DeepTutor is up or the status
 * says why not; `stop()` ends the processes this object started (SIGTERM, SIGKILL after `killAfterMs`) and no others.
 * @param {{
 *   projectDir: string, desktopDir?: string, webPort: number, env?: Record<string, string | undefined>, home?: string,
 *   createProxy(options: { token: string, upstream: string }): { listen(port: number): Promise<number>, close(): Promise<void> },
 *   log?: (line: string) => void, node?: string, spawn?: typeof nodeSpawn, WebSocketImpl?: typeof WebSocket,
 *   readyTimeoutMs?: number, killAfterMs?: number, turnTimeoutMs?: number,
 * }} options
 */
export function createAssistant({ projectDir, desktopDir, webPort, env = process.env, home, createProxy, log = line => console.error(line), node = process.execPath,
  spawn = nodeSpawn, WebSocketImpl = globalThis.WebSocket, readyTimeoutMs = 60000, killAfterMs = 5000, turnTimeoutMs = 20000 }) {
  /** @type {AssistantStatus} */
  let status = { state: 'starting' };
  let ports, proxy, stopped = false;
  const children = new Map();
  /** Every process is on record from the moment it is launched, so a server killed at any point leaves none untracked. */
  const started = [];
  const dataDir = join(projectDir, '.local', 'deeptutor');
  const dtHome = join(dataDir, 'home');
  const processFile = join(dataDir, 'processes.json');
  const fail = reason => { if (!stopped) { status = { state: 'failed', reason }; log(`[assistant] ${reason}`); } };

  /** Runs a short DeepTutor command to completion; resolves with its exit code and the tail of its stderr. */
  const run = (command, args, extraEnv = {}) => new Promise(resolve => {
    const child = spawn(command, args, { cwd: dtHome, env: childEnv(env, { DEEPTUTOR_HOME: dtHome, ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out = (out + chunk).slice(-20000); });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-2000); });
    child.on('error', error => resolve({ code: 127, out, err: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, out, err }));
  });

  const healthy = async () => {
    try { return (await fetch(`http://127.0.0.1:${ports.api}/health/ready`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  };
  const waitFor = async (check, name) => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (stopped) return false;
      if (await check()) return true;
      if (!children.has(name)) return false;
      await sleep(200);
    }
    return false;
  };

  function launch(name, command, args, options) {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
    children.set(name, child);
    let tail = '';
    child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-1500); });
    child.on('error', () => { children.delete(name); });
    child.on('exit', () => {
      children.delete(name);
      // One half gone means the assistant is gone: say so and stop the other half. StudyOrbit itself keeps running.
      if (!stopped && status.state !== 'failed') { fail(`DeepTutor ${name} exited`); if (tail.trim()) log(`[assistant] ${name}: ${tail.trim().split('\n').slice(-3).join(' | ')}`); void stopChildren(); }
    });
    return child;
  }

  async function stopChildren() {
    const running = [...children.values()];
    for (const child of running) child.kill('SIGTERM');
    const deadline = Date.now() + killAfterMs;
    while (children.size && Date.now() < deadline) await sleep(50);
    for (const child of children.values()) child.kill('SIGKILL');
    started.length = 0;
    await rm(processFile, { force: true });
    // Without DeepTutor nothing may use the model proxy: its port closes with the processes.
    await proxy?.close();
    proxy = undefined;
  }

  /** Processes a previous server started and could not stop (it was killed): theirs is a stale proxy token. */
  async function stopLeftovers() {
    const previous = await readJson(processFile);
    const signalled = [];
    for (const entry of Array.isArray(previous) ? previous : []) {
      if (!Number.isInteger(entry?.pid) || typeof entry?.marker !== 'string') continue;
      const { out } = await run('ps', ['-o', 'command=', '-p', String(entry.pid)]);
      // Only a process whose command line still carries what we started it with; a recycled PID is left alone.
      if (!out.includes(entry.marker)) continue;
      log(`[assistant] stopping a DeepTutor process left by an earlier run (pid ${entry.pid})`);
      try { process.kill(entry.pid, 'SIGTERM'); signalled.push(entry.pid); } catch { /* already gone */ }
    }
    const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const deadline = Date.now() + killAfterMs; signalled.some(isAlive) && Date.now() < deadline;) await sleep(50);
    for (const pid of signalled.filter(isAlive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ } }
    await rm(processFile, { force: true });
  }

  async function record(child, marker) {
    started.push({ pid: child.pid, marker });
    await writePrivate(processFile, JSON.stringify(started));
  }

  /** This checkout's instance id: the guard answers with it, which is how a running DeepTutor is recognised as ours. */
  async function instanceId() {
    const file = join(dataDir, 'instance-id');
    try { const saved = (await readFile(file, 'utf8')).trim(); if (/^[0-9a-f]{32}$/.test(saved)) return saved; } catch { /* first start */ }
    const created = randomBytes(16).toString('hex');
    await writePrivate(file, `${created}\n`);
    return created;
  }
  /** Whether what answers on the API port is this project's guarded DeepTutor (decision #549). */
  async function ours(id) {
    try {
      const reply = await fetch(`http://127.0.0.1:${ports.api}/studyorbit-guard/instance`, { signal: AbortSignal.timeout(2000) });
      return reply.ok && (await reply.json())?.instance === id;
    } catch { return false; }
  }

  async function installSkill() {
    const content = await readFile(join(SCRIPTS, 'skill', 'SKILL.md'), 'utf8');
    const description = /^description:\s*(.+)$/m.exec(content)?.[1] ?? '';
    const base = `http://127.0.0.1:${ports.api}/api/skills`;
    const send = (url, method, body) => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const exists = (await fetch(`${base}/studyorbit`, { signal: AbortSignal.timeout(10000) })).ok;
    const reply = exists ? await send(`${base}/studyorbit`, 'PUT', { content }) : await send(`${base}/create`, 'POST', { name: 'studyorbit', description, content });
    if (!reply.ok) throw new Error(`skill install answered ${reply.status}`);
  }

  async function start() {
    try {
      ports = assistantPorts(env, webPort);
      const model = await resolveAnalysisConfig(projectDir, env);
      // Nothing is started in these two cases; the terminal says why, the Agent page says what to do.
      if (model.provider !== 'deepseek') { status = { state: 'unsupported-provider' }; log('[assistant] not started: the assistant works with DeepSeek only and another provider is chosen. The Agent page says what to change; the other pages work without it.'); return; }
      const install = locateInstall(env, home);
      if (!install) { status = { state: 'not-installed' }; log('[assistant] DeepTutor is not installed, so the Agent page shows how to install it. The other pages work without it.'); return; }
      await mkdir(dtHome, { recursive: true, mode: 0o700 });
      await stopLeftovers();
      const url = `http://localhost:${ports.web}`;
      const warning = installWarning(install);
      const instance = await instanceId();
      if (await healthy()) {
        // Something already answers there. It is used only when it is this project's own guarded DeepTutor; another
        // checkout's instance (other courses) or an unguarded DeepTutor is never adopted.
        if (await ours(instance)) { status = { state: 'external', url, ...(warning ? { warning } : {}) }; log('[assistant] this project\'s DeepTutor is already running; using it as it is'); return; }
        return fail(`port ${ports.api} is in use by another DeepTutor or program`);
      }
      if (stopped) return;

      const token = randomBytes(32).toString('hex');
      proxy = createProxy({ token, upstream: DEEPSEEK_UPSTREAM });
      await proxy.listen(ports.proxy);
      if (stopped) return await stopChildren();

      const init = await run(install.bin, ['init', '--non-interactive']);
      if (init.code !== 0) { fail(`deeptutor init failed (exit ${init.code})`); return await stopChildren(); }
      const setupFile = join(dataDir, 'setup.json');
      await writePrivate(setupFile, `${JSON.stringify(setupProfile({ model: model.model, ports }), null, 2)}\n`);
      const applied = await run(install.bin, ['config', 'apply', setupFile], { [PROXY_TOKEN_ENV]: token });
      if (applied.code !== 0) { fail(`deeptutor config apply failed (exit ${applied.code})`); return await stopChildren(); }
      const settings = join(dtHome, 'data', 'user', 'settings');
      await writePrivate(join(settings, 'system.json'), `${JSON.stringify(restrictSystemSettings(await readJson(join(settings, 'system.json'))), null, 2)}\n`);
      // Web search: switched off in DeepTutor's own file, then read back. If that cannot be confirmed, do not start.
      let searchOff = false;
      try { const yaml = join(settings, 'main.yaml'); await writeFile(yaml, disableWebSearch(await readFile(yaml, 'utf8'))); searchOff = webSearchOff(await readFile(yaml, 'utf8')); } catch { /* reported below */ }
      if (!searchOff) { fail('web search could not be switched off in DeepTutor\'s main.yaml'); return await stopChildren(); }
      await writePrivate(join(settings, 'mcp.json'), `${JSON.stringify(mergeMcpConfig(await readJson(join(settings, 'mcp.json')), { node, projectDir, desktopDir }), null, 2)}\n`);
      if (stopped) return await stopChildren();

      const [python, ...apiArgs] = apiCommand({ python: install.python, port: ports.api });
      const api = launch('API', python, apiArgs, { cwd: dtHome, env: childEnv(env, { DEEPTUTOR_HOME: dtHome, DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS: '0', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', ...guardEnv({ ports, webPort, instance }) }) });
      await record(api, 'guard_app:app');
      if (!await waitFor(healthy, 'API')) { if (!stopped && status.state !== 'failed') fail('DeepTutor API did not become ready'); await stopChildren(); return; }

      const prepared = await run(install.python, ['-B', join(SCRIPTS, 'prepare_web.py'), dtHome, String(ports.web), `http://127.0.0.1:${ports.api}`]);
      let web;
      try { web = JSON.parse(prepared.out.trim().split('\n').at(-1)); } catch { web = null; }
      if (stopped) return await stopChildren();
      if (prepared.code !== 0 || typeof web?.server !== 'string') { fail('DeepTutor web files could not be prepared'); await stopChildren(); return; }
      const page = launch('web', node, [web.server], { cwd: dirname(web.server), env: childEnv(env, {
        PORT: String(ports.web), HOSTNAME: '127.0.0.1', DEEPTUTOR_API_BASE_URL: `http://127.0.0.1:${ports.api}`, DEEPTUTOR_AUTH_ENABLED: 'false',
        NEXT_PUBLIC_API_BASE: `http://127.0.0.1:${ports.api}`, NEXT_PUBLIC_AUTH_ENABLED: 'false', DEEPTUTOR_HOME: dtHome,
      }) });
      await record(page, web.server);
      const pageUp = async () => { try { return (await fetch(`http://127.0.0.1:${ports.web}/chat`, { signal: AbortSignal.timeout(2000), redirect: 'manual' })).status < 500; } catch { return false; } };
      if (!await waitFor(pageUp, 'web')) { if (!stopped && status.state !== 'failed') fail('DeepTutor web server did not become ready'); await stopChildren(); return; }

      try { await installSkill(); } catch (error) { fail(`the house rules could not be installed (${error.message})`); await stopChildren(); return; }
      if (stopped || status.state === 'failed') return await stopChildren();
      status = { state: 'running', url, ...(warning ? { warning } : {}) };
      log(`[assistant] DeepTutor ${install.version ?? ''} is running at ${url}`);
    } catch (error) {
      fail(`could not start DeepTutor (${error instanceof Error ? error.message : error})`);
      await stopChildren();
    }
  }

  /** Starts one DeepTutor session with `content` and resolves with its id as soon as DeepTutor reports it. */
  function startTurn({ content, language }) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(`ws://127.0.0.1:${ports.api}/ws`);
      const finish = (action, value) => { clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } action(value); };
      const timer = setTimeout(() => finish(reject, new Error('DeepTutor did not answer in time')), turnTimeoutMs);
      // Optional tools stay off in sessions StudyOrbit starts (decision #545); the course tools come through MCP.
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'start_turn', protocol_version: '2.0', capability: 'chat', content, language, tools: [] })));
      socket.addEventListener('error', () => finish(reject, new Error('DeepTutor WebSocket failed')));
      socket.addEventListener('close', () => finish(reject, new Error('DeepTutor closed the connection')));
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'protocol_error' || message.type === 'error') { finish(reject, new Error(`DeepTutor refused the turn (${message.error_code ?? message.type})`)); return; }
        const sessionId = message.session_id ?? message.metadata?.session_id;
        if (typeof sessionId === 'string' && sessionId) finish(resolve, { sessionId });
      });
    });
  }

  /**
   * Makes DeepTutor's interface and its replies use the language of the StudyOrbit page. DeepTutor keeps the two in
   * its own settings; a browser that has opened DeepTutor before keeps what it stored, so this is the default a new
   * browser starts with, not a switch.
   */
  async function setLanguage(language) {
    if (status.state !== 'running' && status.state !== 'external') throw new Error('DeepTutor is not running');
    const reply = await fetch(`http://127.0.0.1:${ports.api}/api/settings/ui`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language, response_language: language }), signal: AbortSignal.timeout(5000) });
    if (!reply.ok) throw new Error(`DeepTutor's settings answered ${reply.status}`);
  }

  return {
    start,
    status: () => status,
    startTurn,
    setLanguage,
    async stop() {
      stopped = true;
      await stopChildren();
    },
  };
}
