// Shared plumbing of the collector processes (openspec change generic-adapters): the stop flag, the atomic owner-only
// write of the result, and the browser bridge built from the collector configuration.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createAppleScriptBridge } from '../browser/applescript.mjs';
import { createCdpBridge } from '../browser/cdp.mjs';
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

/**
 * The bridge chosen in the configuration: Apple Events on macOS, or the experimental CDP bridge, which asks the local
 * server's dedicated browser over the IPC channel `channel` (the collector's own process by default).
 */
export function bridgeFor(config, { channel = process } = {}) {
  if (config.browser.startsWith('cdp-')) return createCdpBridge({ id: config.browser, allowedOrigins: allowedOrigins(config), channel });
  return createAppleScriptBridge({ id: config.browser, allowedOrigins: allowedOrigins(config) });
}
