import { expect, it, vi } from 'vitest';
import { highlightThenClick } from '../../src/browser/highlight.js';
it('3.4 fronts the page, outlines red, waits at least one second, and clicks exactly once', async () => {
  const order: string[] = []; let now = 0;
  const page = { bringToFront: vi.fn(async () => { order.push('front'); }) };
  const target = { isVisible: vi.fn(async () => true), evaluate: vi.fn(async (fn: (element: HTMLElement | SVGElement) => void) => {
    const element = { style: { outline: '' } }; fn(element as HTMLElement);
    expect(element.style.outline).toMatch(/red/); order.push('outline');
  }), click: vi.fn(async () => { expect(now).toBeGreaterThanOrEqual(1000); order.push('click'); }) };
  const clock = { now: () => now, sleep: vi.fn(async (ms: number) => { now += ms; order.push('wait'); }) };
  await highlightThenClick(page, target, clock);
  expect(order).toEqual(['front', 'outline', 'wait', 'click']); expect(target.click).toHaveBeenCalledOnce();
});
it('3.4 refuses hidden targets, including targets that disappear during the wait, without clicking', async () => {
  for (const initiallyVisible of [false, true]) {
    const page = { bringToFront: vi.fn(async () => {}) };
    const target = { isVisible: vi.fn().mockResolvedValueOnce(initiallyVisible).mockResolvedValue(false),
      evaluate: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    let now = 0; const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
    await expect(highlightThenClick(page, target, clock)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('visible') });
    expect(target.click).not.toHaveBeenCalled();
    if (!initiallyVisible) expect(target.evaluate).not.toHaveBeenCalled();
  }
});
