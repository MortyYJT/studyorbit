// The collector side of the experimental CDP bridges `cdp-chrome` and `cdp-edge` (openspec change generic-adapters,
// design §5, §7, decision #446). A collector never touches the browser: each bridge operation becomes a request over
// the Node IPC channel the local server opened when it spawned the collector, and the server's dedicated-browser host
// (scripts/browser/cdp-host.mjs) applies the origin and method allowlists before anything reaches the browser. The
// origin check is repeated here so a refused URL never leaves the collector. Not verified on Windows or Linux.
import { assertAllowedUrl, assertReadKind, markedUrl, TabUnrecognisedError } from './bridge.mjs';

export const CDP_BRIDGE_IDS = Object.freeze(['cdp-chrome', 'cdp-edge']);
export const CDP_NEEDS_SERVER = '专用浏览器只能在 StudyOrbit 本地服务启动的同步或获取课程里使用';
/** The redirect message of a CDP collect: the owner signs in in the dedicated browser, then resumes. */
export const CDP_SIGN_IN = '请在专用浏览器里登录后继续同步';
export const CDP_REQUEST_TIMEOUT_MS = 60000;
const DISCONNECTED = '与本地服务的连接已断开';

/**
 * A CDP bridge over `channel` (the collector's `process`). `open` refuses origins outside `allowedOrigins` before any
 * request. `dispose` disconnects the channel, so the collector can exit.
 */
export function createCdpBridge({ id, allowedOrigins, channel = process, timeoutMs = CDP_REQUEST_TIMEOUT_MS }) {
  if (!CDP_BRIDGE_IDS.includes(id)) throw new Error(`未知的浏览器桥：${String(id)}`);
  if (typeof channel.send !== 'function' || !channel.connected) throw new Error(CDP_NEEDS_SERVER);
  const origins = [...allowedOrigins];
  const pending = new Map();
  let nextId = 1, gone = false;

  const failAll = () => {
    gone = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(DISCONNECTED)); }
    pending.clear();
  };
  const onMessage = message => {
    if (!message || typeof message !== 'object' || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.ok === true) resolve(message.value);
    else reject(new Error(typeof message.error === 'string' ? message.error : '专用浏览器请求失败'));
  };
  channel.on('message', onMessage);
  channel.on('disconnect', failAll);

  function request(op, payload) {
    if (gone || !channel.connected) return Promise.reject(new Error(DISCONNECTED));
    const requestId = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`专用浏览器没有响应：${op}`)); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try { channel.send({ id: requestId, op, ...payload }); } catch { pending.delete(requestId); clearTimeout(timer); reject(new Error(DISCONNECTED)); }
    });
  }

  return {
    id,
    async open(url, expectedPrefix) {
      assertAllowedUrl(url, origins);
      const tab = await request('open', { url: markedUrl(url), prefix: expectedPrefix });
      if (typeof tab !== 'string' || !tab) throw new TabUnrecognisedError();
      return [tab];
    },
    state: async (tab, expectedPrefix) => request('state', { tab: tab[0], prefix: expectedPrefix }),
    async read(tab, expectedPrefix, kind) {
      assertReadKind(kind);
      return String(await request('read', { tab: tab[0], prefix: expectedPrefix, kind }));
    },
    async close(tab) { await request('close', { tab: tab[0] }); },
    async dispose() {
      channel.off('message', onMessage);
      channel.off('disconnect', failAll);
      failAll();
      if (channel.connected) { try { channel.disconnect(); } catch { /* Already disconnected. */ } }
    },
  };
}
