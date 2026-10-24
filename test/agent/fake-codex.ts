import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export interface FakeRun { fixture?: string; stdout?: string[]; stderr?: string; exit?: number; hang?: boolean }
export interface FakeCall { argv: string[]; cwd: string; env: Record<string, string>; stdin: string; agents: string | null; pid: number }
export const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
/** Never the real CLI: a temporary HOME and a PATH whose first entry is the fake `codex`. Call `vi.unstubAllEnvs()` and `cleanup()` after. */
export function fakeCodex(runs: FakeRun[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fake-codex-')));
  const bin = join(root, 'bin'); const home = join(root, 'home'); const data = join(root, 'data');
  for (const dir of [bin, home, data]) mkdirSync(dir);
  copyFileSync(fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), join(bin, 'codex')); chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'scenario.json'), JSON.stringify(runs));
  vi.stubEnv('HOME', home); vi.stubEnv('PATH', `${bin}:${dirname(process.execPath)}`);
  vi.stubEnv('COURSEWORK_HOME', data); vi.stubEnv('OPENAI_API_KEY', 'synthetic-inherited-key');
  const calls = (): FakeCall[] => existsSync(join(bin, 'calls.jsonl'))
    ? readFileSync(join(bin, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeCall) : [];
  const signals = () => existsSync(join(bin, 'signals')) ? readFileSync(join(bin, 'signals'), 'utf8') : '';
  const cleanup = () => {
    // Only hanging runs can outlive a test; never signal a pid that may have been reused.
    calls().forEach((call, i) => { if (runs[Math.min(i, runs.length - 1)]?.hang) try { process.kill(call.pid, 'SIGKILL'); } catch { /* Already exited. */ } });
    rmSync(root, { recursive: true, force: true });
  };
  return { root, bin, home, data, calls, signals, cleanup };
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function until(check: () => boolean, ms = 5000) {
  for (const end = Date.now() + ms; !check(); await new Promise(resolve => setTimeout(resolve, 10))) if (Date.now() > end) throw new Error('Timed out.');
}
