import type { BrowserContext, Page } from 'playwright';

export async function openHiddenPage(context: BrowserContext, active: Page): Promise<Page> {
  // Playwright newPage creates a foreground target. All supported browsers use CDP.
  const client = await context.newCDPSession(active);
  const cancellation = new AbortController();
  let ready: Promise<Page> | undefined;
  let targetId: string | undefined;
  try {
    const { targetInfo } = await client.send('Target.getTargetInfo');
    let created!: Promise<{ targetId: string }>;
    ready = context.waitForEvent('page', {
      timeout: 30000, signal: cancellation.signal,
      predicate: async page => {
        const target = await created;
        const session = await context.newCDPSession(page);
        try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId === target.targetId; }
        finally { await session.detach(); }
      },
    });
    // Retain a rejection handler while target creation is pending.
    void ready.catch(() => {});
    created = client.send('Target.createTarget', {
      url: 'about:blank', background: true,
      ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
    });
    targetId = (await created).targetId;
    return await ready;
  } catch (error) {
    cancellation.abort();
    await ready?.catch(() => {});
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => {});
    throw error;
  } finally { await client.detach().catch(() => {}); }
}
