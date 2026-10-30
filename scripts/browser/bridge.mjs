// The narrow browser bridge of the collectors (openspec change generic-adapters, design §5, decision #444). A bridge
// can only open an allowed URL in a background tab, report its state, read it in one of a few fixed ways and close it.
// No operation accepts JavaScript text from a caller: `read` maps a kind to a constant expression. No bridge calls a
// cookie, storage, network-interception or download API. `withPage` holds the page loop the collectors shared before
// the move: 20 s to load, 250 ms polling, two read attempts 500 ms apart, and closing the tab in every case.
import { randomUUID } from 'node:crypto';

/** Read kinds and their constant expressions. Nothing else is ever evaluated in a page. */
export const READ_EXPRESSIONS = Object.freeze({
  // Repeats the page's own URL as a synchronous same-origin request to expose the body and the `Link` header; the
  // browser sends its own session, no credential leaves it.
  'same-origin-json': "(() => { const xhr = new XMLHttpRequest(); xhr.open('GET', location.href.split('#')[0], false); xhr.send(); return JSON.stringify({ status: xhr.status, body: xhr.responseText, link: xhr.getResponseHeader('Link') }); })()",
  'body-text': "document.body ? document.body.innerText : ''",
  // HTTP status of the page's navigation, read only after a body-text read failed, so a 429/5xx exits with 75.
  'navigation-status': "String((performance.getEntriesByType('navigation')[0] || {}).responseStatus || '')",
});
export const READ_KINDS = Object.freeze(Object.keys(READ_EXPRESSIONS));

export const LOAD_LIMIT_MS = 20000;
export const POLL_MS = 250;
export const READ_RETRY_MS = 500;

/** Throws unless `url` is an absolute https URL whose origin is in `allowedOrigins`. */
export function assertAllowedUrl(url, allowedOrigins) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('浏览器桥拒绝了无效地址'); }
  if (parsed.protocol !== 'https:' || !allowedOrigins.includes(parsed.origin)) throw new Error(`浏览器桥拒绝打开未允许的地址：${parsed.origin}`);
  return parsed;
}

/** `url` with the random `#studyorbit-<uuid>` fragment that marks a collector's tab. */
export const markedUrl = (url, uuid = randomUUID()) => `${url}#studyorbit-${uuid}`;

export function assertReadKind(kind) {
  if (!Object.hasOwn(READ_EXPRESSIONS, kind)) throw new Error(`未知的读取方式：${String(kind)}`);
  return kind;
}

/** A bridge error that `withPage` turns into the collector's own message. */
export class TabUnrecognisedError extends Error {
  constructor() { super('TAB_UNRECOGNISED'); this.name = 'TabUnrecognisedError'; }
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Opens `url` with `bridge`, waits until it is ready, reads it with `kind` and returns `accept(text)`; the tab is
 * closed in every case. A read whose text `accept` rejects (throws) is tried once more after 500 ms. Options:
 * - `messages`: `{ identity, redirect, timeout }` texts of the collector (as before the move);
 * - `isAborted()`: true once the collector was asked to stop;
 * - `onUnread(tab, error)`: called while the tab is still open when both reads failed (it may throw a better error);
 * - `onCloseError()`: called when the tab could not be closed (the collector reports it after its own result);
 * - `closeFailureFails`: after a successful read, a failed close fails the page (closing is tried once more, as the
 *   Canvas collector did); otherwise it is only reported and the value is returned (as the framework-source collector did);
 * - `sleep`, `now`: test seams.
 */
export async function withPage(bridge, url, expectedPrefix, kind, options) {
  const { accept, messages, isAborted = () => false, onUnread, onCloseError, closeFailureFails = false, sleep = realSleep, now = Date.now } = options;
  assertReadKind(kind);
  let tab;
  try { tab = await bridge.open(url, expectedPrefix); }
  catch (error) { throw error instanceof TabUnrecognisedError ? new Error(messages.identity) : error; }
  const closeQuietly = async () => { try { await bridge.close(tab); } catch { onCloseError?.(); } };
  let value;
  try {
    const until = now() + LOAD_LIMIT_MS;
    let ready = false;
    while (now() < until && !isAborted()) {
      const state = await bridge.state(tab, expectedPrefix);
      if (state === 'redirect') throw new Error(messages.redirect);
      if (state === 'ready') { ready = true; break; }
      await sleep(POLL_MS);
    }
    if (!ready) throw new Error(isAborted() ? '已中止' : messages.timeout);
    let error, read = false;
    for (let attempt = 0; attempt < 2 && !isAborted(); attempt++) {
      try {
        if (attempt) await sleep(READ_RETRY_MS);
        value = accept(await bridge.read(tab, expectedPrefix, kind));
        read = true;
        break;
      } catch (caught) { error = caught; }
    }
    if (!read) {
      if (onUnread) await onUnread(tab, error);
      throw error ?? new Error('已中止');
    }
  } catch (failure) {
    await closeQuietly();
    throw failure;
  }
  try {
    await bridge.close(tab);
  } catch (closeError) {
    if (!closeFailureFails) { onCloseError?.(); return value; }
    await closeQuietly();
    throw closeError;
  }
  return value;
}
