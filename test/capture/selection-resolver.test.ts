import { it, expect, vi } from 'vitest';
import { resolveSelection } from '../../src/capture/selection-resolver.js';
it('returns INVALID_INPUT before any browser/discovery/prompt for absent, invalid or reselect without TTY', async () => {
  for (const status of ['absent', 'invalid', 'valid'] as const) {
    const store = { load: vi.fn(async () => status === 'valid' ? { status, selection: { version: 1 as const, courses: [] } } : { status }), save: vi.fn() };
    const discover = vi.fn(async () => []); const terminal = { write: vi.fn(), question: vi.fn() };
    const result = await resolveSelection({ isTTY: false, reselect: status === 'valid', store, discover, terminal });
    expect(result).toMatchObject({ status: 'error', envelope: { protocol: 'coursework.agent/v1', ok: false, error: { code: 'INVALID_INPUT', next: expect.stringContaining('terminal') } } });
    expect(discover).not.toHaveBeenCalled(); expect(terminal.question).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled();
  }
});
it('reuses valid empty selection without a terminal or discovery', async () => {
  const discover = vi.fn();
  expect(await resolveSelection({ isTTY: false, store: { load: async () => ({ status: 'valid', selection: { version: 1, courses: [] } }), save: vi.fn() }, discover })).toMatchObject({ status: 'ready', selection: { courses: [] } });
  expect(discover).not.toHaveBeenCalled();
});
it('does not authorize a crawl when reuse was cancelled during storage read', async () => {
  const controller = new AbortController(); const discover = vi.fn();
  const result = await resolveSelection({ isTTY: false, signal: controller.signal,
    store: { load: async () => { controller.abort(); return { status: 'valid', selection: { version: 1, courses: [] } }; }, save: vi.fn() }, discover });
  expect(result).toEqual({ status: 'cancelled' }); expect(discover).not.toHaveBeenCalled();
});
