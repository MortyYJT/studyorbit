import type { Envelope } from '../protocol/envelope.js';
import { createInterface } from 'node:readline/promises';
import type { TrustedContext } from '../protocol/context.js';
import { CourseworkError } from '../protocol/errors.js';
import { ResidentBrowser } from './resident.js';

export function ownerResidentBrowser(): ResidentBrowser {
  return new ResidentBrowser({ isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true, confirm: async () => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try { return /^y(?:es)?$/i.test((await terminal.question('Use installed bundled Chromium? [y/N] ')).trim()); }
    finally { terminal.close(); }
  } });
}
/** Mount only this issue's browser commands; all other production ports remain fail-closed. */
export function browserCLIContext(base: TrustedContext): TrustedContext {
  return { ...base, authorization: { ...base.authorization, check: async (name, level, input) => {
    if (['browser.start', 'browser.status', 'browser.stop'].includes(name)) return;
    await base.authorization.check(name, level, input);
  } }, owner: { assertOwner: async name => {
    if (['browser.start', 'browser.stop'].includes(name) && process.stdin.isTTY === true && process.stderr.isTTY === true) return;
    throw new CourseworkError('INVALID_INPUT', 'Owner terminal required.');
  } } };
}

/** Detection's documented CLI codes; all agent envelopes remain protocol-shaped. */
export function browserCLIExitCode(response: Envelope): number {
  if (response.ok) return 0;
  if (response.error.code === 'LOCKED') return 3;
  if (response.error.message === 'COURSEWORK_BROWSER must be one of: msedge, chrome, chromium.') return 2;
  return 1;
}
