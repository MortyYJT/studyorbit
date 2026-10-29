// Runs a real collector script in a child process with test/fixtures/collector-preload.mjs, which fakes osascript, the
// edstem CLI, the Ed scores child and fetch from a synthetic scenario and fixes the clock. Never a browser, the Ed CLI
// or the network. Returns the exit code, output, the written file and the fake's call log.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const repoDir = join(import.meta.dirname, '..');
const preload = join(import.meta.dirname, 'fixtures', 'collector-preload.mjs');

export type CollectorScenario = {
  now?: string; platform?: string; running?: boolean; osascriptError?: string; closeError?: string;
  pages?: Record<string, { status: number; body: string; link: string | null }>;
  texts?: Record<string, string>; state?: Record<string, string>; navigationStatus?: Record<string, number>;
  edstem?: Record<string, unknown>; scores?: unknown; fetch?: Record<string, { status?: number; json?: unknown }>;
};
export type CollectorRun = { code: number | null; stdout: string; stderr: string; output: string | null; calls: Record<string, unknown>[] };

/**
 * `script` is relative to the repository; `args` may contain `<out>`, replaced by a temporary output path. `env` is
 * added to a clean environment (no STUDYORBIT_SOURCE_CONFIG, no NODE_DEBUG unless given).
 */
export async function runCollectorScript(script: string, args: string[], scenario: CollectorScenario, env: Record<string, string> = {}): Promise<CollectorRun> {
  if (!existsSync(preload)) throw new Error('collector preload missing');
  const dir = await mkdtemp(join(tmpdir(), 'studyorbit-collector-'));
  try {
    const scenarioFile = join(dir, 'scenario.json'), logFile = join(dir, 'calls.jsonl'), out = join(dir, 'out', 'result.json');
    await writeFile(scenarioFile, JSON.stringify(scenario));
    await writeFile(logFile, '');
    const base: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) if (process.env[key]) base[key] = process.env[key]!;
    const result = spawnSync(process.execPath, ['--import', preload, join(repoDir, script), ...args.map(arg => (arg === '<out>' ? out : arg))], {
      cwd: repoDir, encoding: 'utf8', timeout: 20000,
      env: { ...base, FAKE_COLLECTOR_SCENARIO: scenarioFile, FAKE_COLLECTOR_LOG: logFile, ...env },
    });
    const output = existsSync(out) ? await readFile(out, 'utf8') : null;
    const calls = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, output, calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The call log with every distinct AppleScript listed once and each call pointing at it by index. */
export function callTranscript(calls: Record<string, unknown>[]) {
  const scripts: string[] = [];
  const steps = calls.map(call => {
    if (call.kind !== 'osascript') return call;
    let index = scripts.indexOf(call.script as string);
    if (index < 0) index = scripts.push(call.script as string) - 1;
    return { kind: 'osascript', script: index, argv: call.argv };
  });
  return { scripts, steps };
}
