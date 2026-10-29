import { describe, expect, it } from 'vitest';
import { createAgentRequest } from '../web/src/agent-request.js';

describe('createAgentRequest', () => {
  it('never reuses a nonce, so a request made after the page reset its request is still acted on', () => {
    const first = createAgentRequest('syn-1', 'Revise SYN10001');
    // The sidebar Agent button clears the current request; the next one must not restart at the same nonce.
    const second = createAgentRequest('syn-2', 'Revise SYN10002');
    expect(second.nonce).toBeGreaterThan(first.nonce);
    expect(second).toMatchObject({ courseId: 'syn-2', prompt: 'Revise SYN10002' });
  });
});
