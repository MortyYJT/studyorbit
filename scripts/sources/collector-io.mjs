// Shared plumbing of the collector processes (openspec change generic-adapters): the stop flag, the atomic owner-only
// write of the result, and the browser bridge built from the collector configuration.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createAppleScriptBridge } from '../browser/applescript.mjs';
import { institutionById } from '../institutions/registry.mjs';

/** A flag set by SIGTERM or SIGINT: the collector finishes its current step and stops. */
export function stopFlag() {
  let stopped = false;
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  return () => stopped;
}

/** Writes `value` as indented JSON to `dest` through a temporary file (0600, directory 0700). */
export async function writeJsonAtomic(dest, value) {
  const path = resolve(dest), tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Origins a collector's bridge may open: the Canvas origin and the origins of the institution's framework source. */
export function allowedOrigins(config) {
  const institution = institutionById(config.institution);
  return [config.canvasOrigin, ...(institution.framework?.origins ?? [])];
}

/** Until the CDP bridge exists (generic-adapters PR 4), a collector configured for it stops with this message. */
export const CDP_NOT_READY = 'Windows 和 Linux 的专用浏览器（CDP）还没有实现；目前只能在 macOS 上用 Edge 或 Chrome 采集';

/** The bridge chosen in the configuration. */
export function bridgeFor(config) {
  if (config.browser.startsWith('cdp-')) throw new Error(CDP_NOT_READY);
  return createAppleScriptBridge({ id: config.browser, allowedOrigins: allowedOrigins(config) });
}
