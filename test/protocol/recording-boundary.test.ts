import { expect, it, vi } from 'vitest';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext, examples } from '../../src/protocol/fakes.js';
it.each(['policy.record', 'grant.record'] as const)('fails closed on wrong %s receipt target', async name => {
  const context = createFakeContext({ owner: true });
  context.services.write = vi.fn(async () => ({ ...examples[name].output, courseId: 'wrong' })) as typeof context.services.write;
  expect(await dispatch(createRegistry(), name, examples[name].input, context)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
});
it('reports non-retryable uncertainty when mandatory completion recording fails after write', async () => {
  const context = createFakeContext(); const calls = vi.spyOn(context.services, 'write');
  context.audit.record = async event => { if (event.phase === 'outcome') throw new Error('secret sentinel'); };
  expect(await dispatch(createRegistry(), 'revision.write', examples['revision.write'].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
  expect(calls).toHaveBeenCalledOnce();
});
