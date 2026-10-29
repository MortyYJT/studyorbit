/** A request from elsewhere in the app to open a fresh chat, optionally scoped to one course and sending a preset prompt. */
export type AgentRequest = { nonce: number; courseId?: string; prompt?: string };

// The counter never restarts while the page is open, even when the app clears its current request, so the Agent page
// (which remembers the last nonce it handled) can tell every new request apart. Seeding it with the clock keeps it
// ahead of that memory even if a dev-server hot reload re-runs this module.
let counter = Date.now();
export function createAgentRequest(courseId?: string, prompt?: string): AgentRequest {
  counter += 1;
  return { nonce: counter, courseId, prompt };
}
