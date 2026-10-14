import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnerSession } from './owner-session.js';
import { readStaticUI } from './static-ui.js';
import { CourseworkError } from './errors.js';
import { dataDir } from '../config/data-dir.js';
import { startHttpTransport } from './http.js';
import type { createProductionProtocol } from './production.js';
/** Host bootstrap details are stderr-only; the secret itself is never printed. */
export async function serveProductionHttp(host: Pick<ReturnType<typeof createProductionProtocol>, 'registry' | 'context'>): Promise<void> {
  const transport = await startHttpTransport({ registry: host.registry, context: host.context, capabilityDirectory: dataDir() });
  process.stderr.write(`coursework http: ${transport.origin}\nCapability file: ${transport.capabilityFile}\n`);
  try {
    await new Promise<void>(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await transport.close(); }
}

export async function openOwnerBrowser(origin: string, session: import('./owner-session.js').OwnerSession, opener: (url: string) => Promise<void>, output: (url: string) => void): Promise<void> {
  const url = session.browserUrl(origin);
  try { await opener(url); }
  catch { output(url); }
}

export interface OwnerUIOptions {
  staticDirectory?: string;
  capabilityDirectory?: string;
  opener?: (url: string) => Promise<void>;
  output?: (url: string) => void;
  isTTY?: boolean;
}
/**
 * No shell interpolation, captured diagnostics, or resident browser attachment.
 * Absolute opener paths and a minimal environment keep a caller-controlled PATH or BROWSER
 * from receiving the owner secret in the URL.
 */
export function systemBrowserCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [] };
  if (platform === 'win32') return { command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler'] };
  return { command: '/usr/bin/xdg-open', args: [] };
}
async function systemBrowser(url: string): Promise<void> {
  const { command, args } = systemBrowserCommand();
  const env = { HOME: process.env.HOME ?? '', DISPLAY: process.env.DISPLAY ?? '', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '' };
  await new Promise<void>((resolve, reject) => {
    execFile(command, [...args, url], { windowsHide: true, env }, error => error ? reject(new Error('Browser opener failed.')) : resolve());
  });
}
export async function startOwnerUI(host: Pick<ReturnType<typeof createProductionProtocol>, 'registry' | 'context'>, options: OwnerUIOptions = {}) {
  const staticDirectory = options.staticDirectory ?? fileURLToPath(new URL('../../dist/ui', import.meta.url));
  if (!await readStaticUI(staticDirectory, '/')) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Frontend build unavailable. Build dist/ui before running coursework ui.');
  const ownerSession = createOwnerSession();
  const transport = await startHttpTransport({ registry: host.registry, context: host.context, ownerSession, staticDirectory,
    capabilityDirectory: options.capabilityDirectory ?? dataDir() });
  const isTTY = options.isTTY ?? (process.stdin.isTTY && process.stderr.isTTY);
  try {
    await openOwnerBrowser(transport.origin, ownerSession, options.opener ?? systemBrowser, url => {
      if (!isTTY) throw new Error('Interactive terminal required.');
      (options.output ?? (value => process.stderr.write(`${value}\n`)))(url);
    });
  }
  catch { await transport.close(); throw new CourseworkError('INTERNAL', 'UI bootstrap failed. Run coursework ui from a terminal.'); }
  return transport;
}
export async function serveProductionUI(host: Pick<ReturnType<typeof createProductionProtocol>, 'registry' | 'context'>): Promise<void> {
  const transport = await startOwnerUI(host);
  try {
    await new Promise<void>(resolve => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await transport.close(); }
}
