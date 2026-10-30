import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startLauncher } from '../scripts/dev.mjs';

// `npm run dev` launcher (design §4, decision #357) with stub child scripts: no real server, no Vite.
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'studyorbit-dev-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const LISTENING = 'StudyOrbit local API listening on http://127.0.0.1:5190';
const env = { PATH: process.env.PATH, NODE_DEBUG: '', STUDYORBIT_API_TOKEN: 'd4'.repeat(32), STUDYORBIT_API_PORT: '5190', STUDYORBIT_WEB_PORT: '5173' };

/** Writes a stub script; `body` runs after it starts recording the signals it receives and records its environment. */
async function stub(name: string, body: string) {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const out = ${JSON.stringify(join(dir, name))};
// Install the handlers before writing the .env file: the tests signal as soon as that file exists.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { appendFileSync(out + '.signals', signal + '\\n'); process.exit(0); });
writeFileSync(out + '.env', JSON.stringify({ token: process.env.STUDYORBIT_API_TOKEN, api: process.env.STUDYORBIT_API_PORT, web: process.env.STUDYORBIT_WEB_PORT, marker: existsSync(${JSON.stringify(join(dir, 'marker'))}) }));
${body}
`);
  return { command: process.execPath, args: [path] };
}
const keepAlive = 'setInterval(() => {}, 1000);';
const listenLater = () => `console.log('preparing'); setTimeout(() => { writeFileSync(${JSON.stringify(join(dir, 'marker'))}, ''); console.log(${JSON.stringify(LISTENING)}); console.log('after'); }, 150); ${keepAlive}`;

function capture() {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}
const read = async (name: string) => JSON.parse(await readFile(join(dir, `${name}.env`), 'utf8'));
const signals = async (name: string) => existsSync(join(dir, `${name}.signals`)) ? (await readFile(join(dir, `${name}.signals`), 'utf8')).trim().split('\n') : [];

describe('dev launcher', () => {
  it('echoes the server output, starts Vite only after the listening line with the token and ports, and exits with Vite\'s code', async () => {
    const output = capture();
    const launcher = startLauncher({ server: await stub('server', listenLater()), web: await stub('web', 'setTimeout(() => process.exit(3), 100);'), env, out: output.out, log: () => {} });
    expect(await launcher.done).toBe(3);
    expect(output.text()).toBe(`preparing\n${LISTENING}\nafter\n`);
    expect(await read('web')).toEqual({ token: env.STUDYORBIT_API_TOKEN, api: '5190', web: '5173', marker: true });
    expect(await read('server')).toMatchObject({ token: env.STUDYORBIT_API_TOKEN, api: '5190', web: '5173' });
    // Vite exited first: the server was stopped.
    expect(await signals('server')).toEqual(['SIGTERM']);
  });

  it('does not start Vite when the server exits during startup, and exits non-zero', async () => {
    const web = await stub('web', keepAlive);
    expect(await startLauncher({ server: await stub('server', 'process.exit(2);'), web, env, out: capture().out, log: () => {} }).done).toBe(2);
    expect(await startLauncher({ server: await stub('server', 'process.exit(0);'), web, env, out: capture().out, log: () => {} }).done).toBe(1);
    expect(existsSync(join(dir, 'web.env'))).toBe(false);
  });

  it('gives up when no listening line appears within the limit', async () => {
    const messages: string[] = [];
    const launcher = startLauncher({ server: await stub('server', `console.log('still starting'); ${keepAlive}`), web: await stub('web', keepAlive), env, out: capture().out, log: line => messages.push(line), startTimeoutMs: 300 });
    expect(await launcher.done).toBe(1);
    expect(existsSync(join(dir, 'web.env'))).toBe(false);
    expect(await signals('server')).toEqual(['SIGTERM']);
    expect(messages.join('\n')).toContain('没有开始监听');
  });

  it('stops Vite when the server exits and exits with the server\'s code', async () => {
    // Exit only once the web stub has written its .env file, so its signal handlers are installed.
    const server = await stub('server', `console.log(${JSON.stringify(LISTENING)}); setInterval(() => { if (existsSync(${JSON.stringify(join(dir, 'web.env'))})) process.exit(4); }, 20);`);
    const launcher = startLauncher({ server, web: await stub('web', keepAlive), env, out: capture().out, log: () => {} });
    expect(await launcher.done).toBe(4);
    expect(await signals('web')).toEqual(['SIGTERM']);
  });

  it('forwards SIGINT and SIGTERM to both processes and exits 0 when both stop cleanly', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      await rm(join(dir, 'server.signals'), { force: true });
      await rm(join(dir, 'web.signals'), { force: true });
      await rm(join(dir, 'web.env'), { force: true });
      const launcher = startLauncher({ server: await stub('server', `console.log(${JSON.stringify(LISTENING)}); ${keepAlive}`), web: await stub('web', keepAlive), env, out: capture().out, log: () => {} });
      await expect.poll(() => existsSync(join(dir, 'web.env'))).toBe(true);
      launcher.signal(signal);
      expect(await launcher.done).toBe(0);
      expect(await signals('server')).toEqual([signal]);
      expect(await signals('web')).toEqual([signal]);
    }
  });

  it('exits at once when the server cannot be spawned, without a later timeout message', async () => {
    const messages: string[] = [];
    const launcher = startLauncher({ server: { command: join(dir, 'missing-binary'), args: [] }, web: await stub('web', keepAlive), env, out: capture().out, log: line => messages.push(line), startTimeoutMs: 200 });
    expect(await launcher.done).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(messages.join('\n')).not.toContain('没有开始监听');
    expect(existsSync(join(dir, 'web.env'))).toBe(false);
  });

  it('treats Ctrl-C during startup as a clean stop even when the server takes longer than the start limit to exit', async () => {
    const messages: string[] = [];
    // Never listens; takes 400 ms to stop, longer than the 200 ms start limit.
    await writeFile(join(dir, 'slow-server.mjs'), `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400)); setInterval(() => {}, 1000);\n`);
    const slow = { command: process.execPath, args: [join(dir, 'slow-server.mjs')] };
    const launcher = startLauncher({ server: slow, web: await stub('web', keepAlive), env, out: capture().out, log: line => messages.push(line), startTimeoutMs: 200 });
    await new Promise(resolve => setTimeout(resolve, 50));
    launcher.signal('SIGTERM');
    expect(await launcher.done).toBe(0);
    expect(messages).toEqual([]);
    expect(existsSync(join(dir, 'web.env'))).toBe(false);
  });
});
