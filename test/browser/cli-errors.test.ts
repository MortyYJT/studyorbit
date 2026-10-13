import { expect, it, vi } from 'vitest';
import { BrowserChoiceError } from '../../src/capture/browser.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { browserCLIExitCode } from '../../src/browser/runtime.js';
it.each([
  [new BrowserChoiceError('COURSEWORK_BROWSER must be one of: msedge, chrome, chromium.', 2), 2, /msedge.*chrome.*chromium/],
  [new BrowserChoiceError('Bundled Chromium declined.'), 1, /declined/],
  [new BrowserChoiceError('Profile records chrome, but detection selected msedge. Set COURSEWORK_BROWSER=chrome or remove the profile and sign in again.'), 1, /chrome.*msedge.*COURSEWORK_BROWSER/],
  [new CourseworkError('LOCKED', 'Browser profile is locked by process 12345.'), 3, /12345/],
])('3.1 CLI preserves safe detection/lock recovery and exit status', async (error, exitCode, message) => {
  const start = vi.fn(async () => { throw error; });
  const registry = createRegistry({ browser: { start } });
  const lines: string[] = []; const context = createFakeContext({ owner: true });
  await parseProtocolCLI(['browser', 'start'], { registry, context, isTTY: true, stderr: () => {}, stdout: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  const result = JSON.parse(lines[0]!);
  expect(result).toMatchObject({ ok: false, error: { message: expect.stringMatching(message) } });
  expect(browserCLIExitCode(result)).toBe(exitCode);
  expect(start).toHaveBeenCalledOnce();
});
it('3.1 rejects unsafe browser errors and never returns the private endpoint from start', async () => {
  const context = createFakeContext({ owner: true });
  const bad = createRegistry({ browser: { start: async () => { throw new BrowserChoiceError('Cookie=sentinel'); } } });
  expect(JSON.stringify(await dispatch(bad, 'browser.start', {}, context))).not.toContain('sentinel');
  const good = createRegistry({ browser: { start: async () => ({ endpoint: 'http://127.0.0.1:43210', pid: 12345,
    browser: 'msedge', startedAt: '2026-01-01T00:00:00.000Z' }) } });
  const result = await dispatch(good, 'browser.start', {}, context);
  expect(result).toMatchObject({ ok: true, data: { running: true, browser: 'msedge' } });
  expect(JSON.stringify(result)).not.toMatch(/endpoint|43210/);
});
