/** A request from elsewhere in the app to open a fresh chat, optionally scoped to one course and sending a preset prompt. */
export type AgentRequest = { nonce: number; courseId?: string; prompt?: string };

// The counter never restarts while the page is open, even when the app clears its current request, so the Agent page
// (which remembers the last nonce it handled) can tell every new request apart. Seeding it with the clock keeps it
// ahead of that memory even if a dev-server hot reload re-runs this module.
let counter = Date.now();
// A request is acted on once, by whichever page takes it first. The Agent page is unmounted on every page switch and
// when the owner moves between DeepTutor and the old chat, so this memory lives outside the components: otherwise the
// same preset prompt would be sent again by each of them.
const claimed = new Set<number>();
/** True the first time a request is claimed; the caller that gets true sends its prompt. */
export function claimAgentRequest(nonce: number): boolean {
  if (claimed.has(nonce)) return false;
  claimed.add(nonce);
  return true;
}
export function agentRequestClaimed(nonce: number): boolean { return claimed.has(nonce); }

export function createAgentRequest(courseId?: string, prompt?: string): AgentRequest {
  counter += 1;
  return { nonce: counter, courseId, prompt };
}
