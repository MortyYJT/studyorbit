// The server-owned dedicated browser of the experimental CDP bridge (openspec change generic-adapters, design §7,
// decision #446). Single sign-on often uses session-only cookies, which a browser drops when it closes, so the local
// server keeps one long-lived browser: launched on demand (「打开专用浏览器」 or the first browser-using collect),
// kept across collectors and jobs, closed only when the owner closes it, the browser setting changes or the server
// shuts down. The owner signs in in that window.
//
// Collectors stay child processes. Their bridge (scripts/browser/cdp.mjs) sends `{ id, op, ... }` requests over a Node
// IPC channel; the host checks each request against the collector's origin allowlist (built by the server from the
// configuration it gave the collector, not from the request), checks that the tab belongs to that collector, and only
// then talks to the browser through the method allowlist of the pipe. When a collector exits, its open tabs are
// closed; the browser stays. Not verified on Windows or Linux.
import { assertAllowedUrl, assertReadKind, READ_EXPRESSIONS } from './bridge.mjs';
import { closeCdpBrowser, startCdpBrowser } from './cdp-launch.mjs';
import { STATE_EXPRESSION } from './cdp-pipe.mjs';
import { allowedOrigins } from '../sources/collector-io.mjs';
import { canvasOrigin as checkedCanvasOrigin, readSourceConfig, SOURCE_CONFIG_ENV } from '../sources/config.mjs';

export const HOST_CLOSING = '本地服务正在关闭';
export const TAB_GONE = '标签页不存在或已关闭';
const OPS = new Set(['open', 'state', 'read', 'close']);
const MAX_TEXT = 4096;

const isText = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;

/** True when `url` parses and its origin is one of `origins`. */
function originAllowed(url, origins) {
  try { return origins.includes(new URL(url).origin); } catch { return false; }
}

/**
 * The host. `start`/`close` default to the real launcher (tests pass a fake browser). `projectDir` decides the profile
 * directory; `platform` and `env` the executable lookup.
 */
export function createCdpHost({ projectDir, platform = process.platform, env = process.env, start = startCdpBrowser, close = closeCdpBrowser }) {
  /** The running browser: `{ started, key, tabs: Map<targetId, { client, sessionId }> }`, or null. */
  let current = null;
  let starting = null, startingKey = null;
  /** A browser being closed: a new one is not launched on the same profile until it is gone. */
  let closing = null;
  let shuttingDown = false;

  const keyOf = (browser, browserPath) => JSON.stringify([browser, browserPath ?? null]);

  async function closeCurrent() {
    const entry = current;
    if (entry) {
      current = null;
      entry.tabs.clear();
      const done = close(entry.started).catch(() => { /* The process is gone or was killed. */ })
        .finally(() => { if (closing === done) closing = null; });
      closing = done;
    }
    await closing;
  }

  /** The running browser for `browser`/`browserPath`, launching (or replacing) it when needed. */
  async function ensure({ browser, browserPath }) {
    const key = keyOf(browser, browserPath);
    for (;;) {
      if (shuttingDown) throw new Error(HOST_CLOSING);
      if (starting) {
        // A failed launch of the same browser fails every request that waited for it, instead of each retrying.
        const pending = starting, pendingKey = startingKey;
        try { await pending; } catch (error) { if (pendingKey === key) throw error; }
        continue;
      }
      if (closing) { await closing; continue; }
      if (current && current.started.running() && current.key === key) return current;
      if (current) { await closeCurrent(); continue; }
      startingKey = key;
      starting = (async () => {
        const started = await start({ id: browser, browserPath: browserPath ?? null, projectDir, platform, env });
        const entry = { started, key, tabs: new Map() };
        // The owner closed the window (or the browser died): the next request launches a new one.
        started.exited.then(() => { if (current === entry) current = null; });
        if (shuttingDown) { await close(started).catch(() => {}); throw new Error(HOST_CLOSING); }
        current = entry;
        return entry;
      })();
      try { return await starting; } finally { starting = null; startingKey = null; }
    }
  }

  const send = (entry, method, params, sessionId) => entry.started.pipe.send(method, params, sessionId);

  /** The tab `targetId` of `client` in the running browser. */
  function tabOf(client, targetId) {
    const tab = isText(targetId) ? current?.tabs.get(targetId) : undefined;
    if (!tab || tab.client !== client || !current.started.running()) throw new Error(TAB_GONE);
    return { entry: current, tab };
  }

  async function targetUrl(entry, targetId) {
    const { targetInfo } = await send(entry, 'Target.getTargetInfo', { targetId });
    return typeof targetInfo?.url === 'string' ? targetInfo.url : '';
  }

  async function evaluate(entry, tab, expression) {
    const reply = await send(entry, 'Runtime.evaluate', { expression, returnByValue: true }, tab.sessionId);
    if (reply.exceptionDetails) throw new Error('PAGE_SCRIPT_FAILED');
    const value = reply.result?.value;
    return value === undefined || value === null ? '' : String(value);
  }

  async function closeTab(entry, targetId) {
    await send(entry, 'Target.closeTarget', { targetId });
    entry.tabs.delete(targetId);
  }

  const operations = {
    async open(client, { url, prefix }) {
      if (!isText(url) || !isText(prefix)) throw new Error('请求无效');
      assertAllowedUrl(url, client.allowedOrigins);
      assertAllowedUrl(prefix, client.allowedOrigins);
      const entry = await ensure(client);
      const { targetId } = await send(entry, 'Target.createTarget', { url, background: true });
      if (!isText(targetId)) throw new Error('TAB_UNRECOGNISED');
      const tab = { client, sessionId: null };
      entry.tabs.set(targetId, tab);
      try {
        // A collector that exited meanwhile never gets the tab: it is closed right away.
        if (client.closed) throw new Error(TAB_GONE);
        const { sessionId } = await send(entry, 'Target.attachToTarget', { targetId, flatten: true });
        if (!isText(sessionId)) throw new Error('TAB_UNRECOGNISED');
        tab.sessionId = sessionId;
      } catch (error) {
        await closeTab(entry, targetId).catch(() => {});
        throw error;
      }
      return targetId;
    },
    async state(client, { tab: targetId, prefix }) {
      if (!isText(prefix)) throw new Error('请求无效');
      const { entry, tab } = tabOf(client, targetId);
      const url = await targetUrl(entry, targetId);
      // A new tab may still show its initial blank page before the navigation commits.
      if (url === '' || url === 'about:blank') return 'loading';
      if (!url.startsWith(prefix)) return 'redirect';
      return (await evaluate(entry, tab, STATE_EXPRESSION)) === 'complete' ? 'ready' : 'loading';
    },
    async read(client, { tab: targetId, prefix, kind }) {
      if (!isText(prefix)) throw new Error('请求无效');
      assertReadKind(kind);
      const { entry, tab } = tabOf(client, targetId);
      const url = await targetUrl(entry, targetId);
      // Never read a page outside the collector's origins (a sign-in page after a redirect), whatever the prefix.
      if (!originAllowed(url, client.allowedOrigins)) throw new Error('UNEXPECTED_URL');
      if (kind !== 'navigation-status') {
        if (!url.startsWith(prefix)) throw new Error('UNEXPECTED_URL');
        if ((await evaluate(entry, tab, STATE_EXPRESSION)) !== 'complete') throw new Error('PAGE_STILL_LOADING');
      }
      const value = await evaluate(entry, tab, READ_EXPRESSIONS[kind]);
      // The page may have navigated between the check and the read (a script redirecting to a sign-in page): the
      // value is returned only if the tab is still on an allowed page.
      const after = await targetUrl(entry, targetId);
      if (!originAllowed(after, client.allowedOrigins) || (kind !== 'navigation-status' && !after.startsWith(prefix))) throw new Error('UNEXPECTED_URL');
      return value;
    },
    async close(client, { tab: targetId }) {
      const { entry } = tabOf(client, targetId);
      await closeTab(entry, targetId);
      return true;
    },
  };

  /** Closes the tabs `client` left open (its process exited or was killed). The browser stays. */
  async function releaseClient(client) {
    client.closed = true;
    const entry = current;
    if (!entry) return;
    const left = [...entry.tabs].filter(([, tab]) => tab.client === client).map(([targetId]) => targetId);
    await Promise.all(left.map(targetId => closeTab(entry, targetId).catch(() => { entry.tabs.delete(targetId); })));
  }

  return {
    /**
     * The collector client of a command's environment: `{ browser, browserPath, allowedOrigins }` when its
     * configuration uses a CDP bridge, else null. The origins come from the configuration the server built.
     */
    clientFor(commandEnv) {
      const raw = commandEnv?.[SOURCE_CONFIG_ENV];
      if (!raw) return null;
      const config = readSourceConfig({ env: { [SOURCE_CONFIG_ENV]: raw } });
      if (!config.browser.startsWith('cdp-')) return null;
      return { browser: config.browser, browserPath: config.browserPath, allowedOrigins: allowedOrigins(config) };
    },

    /** Serves the bridge requests of a collector child with an IPC channel until it exits or disconnects. */
    attach(child, spec) {
      const client = { browser: spec.browser, browserPath: spec.browserPath ?? null, allowedOrigins: Object.freeze([...spec.allowedOrigins]), closed: false };
      const reply = message => { if (child.connected) { try { child.send(message, () => {}); } catch { /* The child is gone. */ } } };
      const onMessage = message => {
        if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id) || message.id < 1) return;
        const { id, op } = message;
        const work = OPS.has(op) ? operations[op](client, message) : Promise.reject(new Error('未知的请求'));
        Promise.resolve(work).then(value => reply({ id, ok: true, value }), error => reply({ id, ok: false, error: String(error?.message ?? error).slice(0, 500) }));
      };
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        child.off('message', onMessage);
        void releaseClient(client);
      };
      child.on('message', onMessage);
      child.once('exit', release);
      child.once('disconnect', release);
      return release;
    },

    /** 「打开专用浏览器」: the browser (launched if needed) shows the Canvas origin in a new foreground tab. */
    async openSignIn({ browser, browserPath, canvasOrigin }) {
      const origin = checkedCanvasOrigin(canvasOrigin);
      const entry = await ensure({ browser, browserPath });
      await send(entry, 'Target.createTarget', { url: `${origin}/`, background: false });
    },

    /** The source settings were saved: a running browser of another kind or program is closed. */
    async settingsChanged({ browser, browserPath }) {
      if (current && current.key !== keyOf(browser, browserPath)) await closeCurrent();
    },

    /** Server shutdown: no new work; the browser gets `Browser.close`, then is killed after 5 s. */
    async shutdown() {
      shuttingDown = true;
      await starting?.catch(() => {});
      await closeCurrent();
      await closing;
    },

    running: () => Boolean(current?.started.running()),
  };
}
