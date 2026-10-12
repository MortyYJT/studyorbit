import { expect, it } from 'vitest';
import { createFakeContext } from '../../src/protocol/fakes.js';

it('fake privacy keeps structural ids whose segments are all digits', async () => {
  const revision = '12345678-1234-4234-8234-123456789012';
  const protectedValue = await createFakeContext().privacy.protect('proposals.get', { revision, note: 'Mail a.b@example.edu' });
  expect(protectedValue).toEqual({ revision, note: 'Mail [redacted]' });
});
