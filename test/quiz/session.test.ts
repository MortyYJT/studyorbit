import { expect, it, vi } from 'vitest';
import { openManagedQuizSession } from '../../src/quiz/read/session.js';
import { CourseworkError } from '../../src/protocol/errors.js';
import { target } from './synthetic.js';
it('default live reads fail closed until actual-course prerequisites are wired by issue B', async () => {
  const acquireLock = vi.fn(() => () => {});
  await expect(openManagedQuizSession(target, { acquireLock })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(acquireLock).not.toHaveBeenCalled();
});
it('reuses the profile lock and propagates LOCKED before launch', async () => {
  const launch = vi.fn();
  await expect(openManagedQuizSession(target, { verifyPrerequisites: async () => {},
    acquireLock: () => { throw new CourseworkError('LOCKED', 'private-sentinel'); }, launch })).rejects.toMatchObject({ code: 'LOCKED' });
  expect(launch).not.toHaveBeenCalled();
});
it('never prompts or falls back when noninteractive browser selection fails; releases lock', async () => {
  const release = vi.fn(); const launch = vi.fn(); const chooseBrowser = vi.fn(async (options: { isTTY: boolean; confirm: () => Promise<boolean> }) => {
    expect(options.isTTY).toBe(false); expect(await options.confirm()).toBe(false); throw Error('private-sentinel');
  });
  await expect(openManagedQuizSession(target, { verifyPrerequisites: async () => {}, acquireLock: () => release, chooseBrowser, launch })).rejects.toThrow();
  expect(release).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled();
});
it('closes browser and releases lock when hidden-page creation fails', async () => {
  const release = vi.fn(); const close = vi.fn(async () => {});
  const context = { pages: () => [{ isClosed: () => false, evaluate: async () => true }], close };
  await expect(openManagedQuizSession(target, { verifyPrerequisites: async () => {}, acquireLock: () => release,
    chooseBrowser: async () => 'chrome', launch: async () => context as never, recordBrowser: () => {},
    openHiddenPage: async () => { throw Error('private-sentinel'); } })).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
it.each(['SIGINT', 'SIGTERM'] as const)('closes a hanging GET and releases the lock on %s', async signal => {
  let rejectRead!: (error: Error) => void;
  const evaluate = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectRead = reject; }));
  const page = { url: () => 'https://edstem.org/au/', evaluate };
  const release = vi.fn(); const close = vi.fn(async () => { rejectRead?.(Error('private-sentinel')); });
  const context = { pages: () => [{ isClosed: () => false, evaluate: async () => true }], close };
  const before = process.listenerCount(signal);
  const session = await openManagedQuizSession(target, { verifyPrerequisites: async () => {}, acquireLock: () => release,
    chooseBrowser: async () => 'chrome', launch: async () => context as never, recordBrowser: () => {}, openHiddenPage: async () => page as never });
  const pending = session.transport.read('/api/courses/7/lessons');
  await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce());
  try {
    process.emit(signal);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(await pending).toMatchObject({ kind: 'gap' });
    await session.close(); expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount(signal)).toBe(before);
  } finally { await session.close(); await pending; }
});
