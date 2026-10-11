import { expect, it, vi } from 'vitest';
import { openHiddenPage } from '../../src/capture/tab.js';
function fixture() {
  const active = {}; const page = {}; const unrelated = {};
  const creator = { send: vi.fn(async (method: string) => method === 'Target.getTargetInfo' ? { targetInfo: { browserContextId: 'synthetic-context' } } : { targetId: 'synthetic-crawl' }), detach: vi.fn(async () => {}) };
  const pageSession = { send: vi.fn(async () => ({ targetInfo: { targetId: 'synthetic-crawl' } })), detach: vi.fn(async () => {}) };
  const otherSession = { send: vi.fn(async () => ({ targetInfo: { targetId: 'synthetic-other' } })), detach: vi.fn(async () => {}) };
  const context = {
    newCDPSession: vi.fn(async (target: unknown) => target === active ? creator : target === page ? pageSession : otherSession),
    waitForEvent: vi.fn(async (_event: string, options: { predicate: (page: unknown) => Promise<boolean>; signal: AbortSignal }) => {
      await new Promise(resolve => setImmediate(resolve));
      expect(await options.predicate(unrelated)).toBe(false);
      expect(await options.predicate(page)).toBe(true); return page;
    }),
  };
  return { active, page, creator, pageSession, otherSession, context };
}
it('creates a background tab in the same context and selects its matching target, without activating it', async () => {
  const f = fixture(); expect(await openHiddenPage(f.context as never, f.active as never)).toBe(f.page);
  expect(f.creator.send).toHaveBeenCalledWith('Target.createTarget', { url: 'about:blank', background: true, browserContextId: 'synthetic-context' });
  expect(f.context.waitForEvent).toHaveBeenCalledWith('page', expect.objectContaining({ timeout: 30000 }));
  expect(f.creator.detach).toHaveBeenCalledOnce(); expect(f.pageSession.detach).toHaveBeenCalledOnce(); expect(f.otherSession.detach).toHaveBeenCalledOnce();
});
it('creation error cancels the event waiter and releases its CDP session', async () => {
  const f = fixture(); f.creator.send.mockRejectedValueOnce(new Error('target info unavailable'));
  await expect(openHiddenPage(f.context as never, f.active as never)).rejects.toThrow('target info unavailable');
  expect(f.creator.detach).toHaveBeenCalledOnce(); expect(f.context.waitForEvent).not.toHaveBeenCalled();
});
