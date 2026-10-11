import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/capture/command.js', () => ({ capture: vi.fn() }));
vi.mock('commander', () => ({
  Command: class {
    handler?: () => Promise<void>;
    name() { return this; }
    description() { return this; }
    version() { return this; }
    option() { return this; }
    command() { return this; }
    action(handler: () => Promise<void>) { this.handler = handler; return this; }
    async parseAsync() { await this.handler?.(); }
  },
}));
const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); });

it.each([
  { kind: 'LOCKED', status: 3, message: 'locked by process 123' },
  { kind: 'plain', status: 1, message: 'Capture failed' },
  { kind: 'INTERNAL', status: 1, message: 'Capture failed' },
])('maps $kind to exit $status', async ({ kind, status, message }) => {
  vi.resetModules();
  const { CourseworkError } = await import('../src/protocol/errors.js');
  const error = kind === 'plain'
    ? Object.assign(new Error('untrusted lock error'), { code: 'LOCKED' })
    : new CourseworkError(kind === 'LOCKED' ? 'LOCKED' : 'INTERNAL', 'Browser profile is locked by process 123.');
  const { capture } = await import('../src/capture/command.js');
  vi.mocked(capture).mockRejectedValueOnce(error);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../src/cli.js');
  expect(process.exitCode).toBe(status);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(message));
});


it.each([1, 2])('prints browser choice recovery and exits %s', async status => {
  vi.resetModules();
  const { BrowserChoiceError } = await import('../src/capture/browser.js');
  const { capture } = await import('../src/capture/command.js');
  vi.mocked(capture).mockRejectedValueOnce(new BrowserChoiceError('Set COURSEWORK_BROWSER to msedge, chrome, chromium.', status));
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../src/cli.js');
  expect(process.exitCode).toBe(status);
  expect(stderr).toHaveBeenCalledWith('Set COURSEWORK_BROWSER to msedge, chrome, chromium.');
});
