// Running Agent replies, one per chat. `begin` claims a chat synchronously, so a check-then-set race across
// an `await` cannot let two replies append to the same conversation.
export function createReplyRegistry() {
  /** @type {Map<string, { controller: AbortController, ended: Promise<void>, resolve: () => void }>} */
  const replies = new Map();
  return {
    /** Claim the chat and return its AbortController, or null when a reply is already running. */
    begin(id) {
      if (replies.has(id)) return null;
      let resolve = () => {};
      const ended = new Promise(done => { resolve = done; });
      const controller = new AbortController();
      replies.set(id, { controller, ended, resolve });
      return controller;
    },
    /** Release the chat; only the reply that holds it can release it. */
    end(id, controller) {
      const reply = replies.get(id);
      if (!reply || reply.controller !== controller) return;
      replies.delete(id);
      reply.resolve();
    },
    running(id) { return replies.has(id); },
    /** Abort the running reply, if any. */
    stop(id) {
      const reply = replies.get(id);
      reply?.controller.abort();
      return !!reply;
    },
    /** Abort the running reply and wait until it has saved its partial text and released the chat. */
    async stopAndWait(id) {
      const reply = replies.get(id);
      if (!reply) return false;
      reply.controller.abort();
      await reply.ended;
      return true;
    },
  };
}
