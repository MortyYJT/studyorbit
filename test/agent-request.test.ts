import { describe, expect, it } from 'vitest';
import { agentRequestClaimed, claimAgentRequest, createAgentRequest } from '../web/src/agent-request.js';

describe('createAgentRequest', () => {
  it('never reuses a nonce, so a request made after the page reset its request is still acted on', () => {
    const first = createAgentRequest('syn-1', 'Revise SYN10001');
    // The sidebar Agent button clears the current request; the next one must not restart at the same nonce.
    const second = createAgentRequest('syn-2', 'Revise SYN10002');
    expect(second.nonce).toBeGreaterThan(first.nonce);
    expect(second).toMatchObject({ courseId: 'syn-2', prompt: 'Revise SYN10002' });
  });
});

describe('claimAgentRequest', () => {
  it('lets exactly one page act on a request, however often pages are mounted', () => {
    const request = createAgentRequest('syn-1', 'Revise SYN10001');
    expect(agentRequestClaimed(request.nonce)).toBe(false);
    // DeepTutor's page takes it; the old chat, opened afterwards with the same request, and a remount must not.
    expect(claimAgentRequest(request.nonce)).toBe(true);
    expect(claimAgentRequest(request.nonce)).toBe(false);
    expect(agentRequestClaimed(request.nonce)).toBe(true);
    expect(claimAgentRequest(createAgentRequest('syn-1', 'Again').nonce)).toBe(true);
  });
});
