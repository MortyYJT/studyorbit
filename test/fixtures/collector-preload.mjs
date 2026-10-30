// Test-only preload (`node --import`) that runs a real collector script against synthetic responses: it replaces
// `child_process.execFile` (osascript, the edstem CLI and the Ed scores child) and `fetch` with fakes driven by a
// scenario file, fixes the clock and the platform, and logs every call. Nothing reaches a browser, the Ed CLI or the
// network: any call the scenario does not describe fails. Used only by test/collector-harness.ts.
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const scenarioPath = process.env.FAKE_COLLECTOR_SCENARIO;
const logPath = process.env.FAKE_COLLECTOR_LOG;
if (!scenarioPath || !logPath) throw new Error('collector-preload: FAKE_COLLECTOR_SCENARIO and FAKE_COLLECTOR_LOG are required');
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const log = entry => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

Object.defineProperty(process, 'platform', { value: scenario.platform ?? 'darwin' });

// A fixed clock: `new Date()` and `Date.now()` return the scenario's instant, so durations are 0.
const fixed = Date.parse(scenario.now ?? '2026-10-30T00:00:00.000Z');
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixed])); }
  static now() { return fixed; }
}
globalThis.Date = FixedDate;

const withoutFragment = url => String(url).split('#')[0];
const tabs = new Map();
let nextTab = 0;

/** The fake's answer for one call: `{ stdout }` or `{ error }`. */
function answer(file, args) {
  if (file === '/usr/bin/osascript') {
    const [flag, script, ...argv] = args;
    if (flag !== '-e') return { error: 'unexpected osascript call' };
    const at = argv.map(value => String(value).replace(/#studyorbit-[0-9a-f-]{36}$/, '#studyorbit-<uuid>'));
    log({ kind: 'osascript', script, argv: at });
    if (scenario.osascriptError) return { error: scenario.osascriptError };
    if (/is running/.test(script) && !/make new tab/.test(script)) return { stdout: scenario.running === false ? 'false' : 'true' };
    if (/make new tab/.test(script)) {
      const id = `tab-${++nextTab}`;
      tabs.set(id, withoutFragment(argv[0]));
      return { stdout: `7:${id}` };
    }
    const url = tabs.get(argv[1]);
    if (/close t$/m.test(script)) return scenario.closeError ? { error: scenario.closeError } : { stdout: '' };
    if (/return "ready"/.test(script)) return { stdout: scenario.state?.[url] ?? 'ready' };
    if (/execute t javascript \(item 4 of argv\)/.test(script)) {
      const page = scenario.pages?.[url];
      return page ? { stdout: JSON.stringify(page) } : { error: `no page for ${url}` };
    }
    if (/document\.body \? document\.body\.innerText/.test(script)) return { stdout: scenario.texts?.[url] ?? '' };
    if (/performance\.getEntriesByType/.test(script)) return { stdout: String(scenario.navigationStatus?.[url] ?? '') };
    return { error: 'unknown osascript script' };
  }
  if (file === 'edstem') {
    const key = args.join(' ');
    log({ kind: 'edstem', args });
    return Object.hasOwn(scenario.edstem ?? {}, key) ? { stdout: JSON.stringify(scenario.edstem[key]) } : { error: `no edstem answer for ${key}` };
  }
  if (file === process.execPath && /scores\.mjs$/.test(String(args[0]))) {
    const ids = args.slice(1);
    log({ kind: 'scores', ids });
    return scenario.scores ? { stdout: JSON.stringify(scenario.scores) } : { error: 'no scores answer' };
  }
  log({ kind: 'refused', file });
  return { error: `collector-preload refused ${file}` };
}

function fakeExecFile(file, args = [], options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const result = answer(file, args);
  queueMicrotask(() => {
    if (result.error) done?.(Object.assign(new Error(result.error), { stderr: result.error, stdout: '' }), '', result.error);
    else done?.(null, `${result.stdout}\n`, '');
  });
  return { pid: undefined, kill() {}, on() {} };
}
fakeExecFile[promisify.custom] = (file, args = []) => {
  const result = answer(file, args);
  return result.error
    ? Promise.reject(Object.assign(new Error(result.error), { stderr: result.error, stdout: '' }))
    : Promise.resolve({ stdout: `${result.stdout}\n`, stderr: '' });
};
childProcess.execFile = fakeExecFile;
childProcess.spawn = () => { throw new Error('collector-preload refused spawn'); };
syncBuiltinESMExports();

globalThis.fetch = async (url, init = {}) => {
  log({ kind: 'fetch', url: String(url), authorization: init.headers?.Authorization ? '<redacted>' : null });
  const reply = scenario.fetch?.[String(url)];
  if (!reply) throw new Error(`collector-preload refused fetch ${url}`);
  return new Response(JSON.stringify(reply.json ?? null), { status: reply.status ?? 200, headers: { 'Content-Type': 'application/json' } });
};
