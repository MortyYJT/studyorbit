// The pipe transport of the experimental CDP bridge (openspec change generic-adapters, design §7, decision #446).
// The browser is started with `--remote-debugging-pipe`: it reads commands from its fd 3 and writes replies and events
// to its fd 4, one JSON message per frame, frames separated by a NUL byte (the transport Playwright uses). There is no
// listening port; only the process that launched the browser holds the pipe.
//
// Security: every command passes the method allowlist before anything is written. Only the target methods needed to
// open, inspect and close a background tab, `Runtime.evaluate` with one of the constant expressions, and
// `Browser.close` are allowed; no cookie, storage, network-interception or download method can be sent. Events are
// ignored.
import { READ_EXPRESSIONS } from './bridge.mjs';

/** The one expression `state` may evaluate: CDP has no loading flag on a target. */
export const STATE_EXPRESSION = 'document.readyState';
/** Every expression the CDP bridge may evaluate: the read kinds' constants and the state constant. */
export const CDP_EXPRESSIONS = Object.freeze([...Object.values(READ_EXPRESSIONS), STATE_EXPRESSION]);

export const CDP_COMMAND_TIMEOUT_MS = 30000;
/** Largest frame the transport buffers; a page read is far smaller (Canvas pages hold at most 100 items). */
export const CDP_MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const PIPE_CLOSED = '专用浏览器已关闭';

const refuse = (method, why) => { throw new Error(`CDP 命令不在允许列表里：${method}${why ? `（${why}）` : ''}`); };
const isString = value => typeof value === 'string' && value.length > 0 && value.length <= 8192;
/** True when `params` has exactly the keys of `required` plus any of `optional`. */
const keysAre = (params, required, optional = []) => required.every(key => Object.hasOwn(params, key))
  && Object.keys(params).every(key => required.includes(key) || optional.includes(key));

/** Parameter checks per allowed method. A session id is accepted only where a page is addressed. */
const RULES = Object.freeze({
  'Target.createTarget': params => keysAre(params, ['url', 'background']) && isString(params.url) && params.url.startsWith('https://') && typeof params.background === 'boolean',
  'Target.attachToTarget': params => keysAre(params, ['targetId', 'flatten']) && isString(params.targetId) && params.flatten === true,
  'Target.getTargetInfo': params => keysAre(params, [], ['targetId']) && (params.targetId === undefined || isString(params.targetId)),
  'Target.closeTarget': params => keysAre(params, ['targetId']) && isString(params.targetId),
  'Runtime.evaluate': params => keysAre(params, ['expression', 'returnByValue']) && CDP_EXPRESSIONS.includes(params.expression) && params.returnByValue === true,
  'Browser.close': params => keysAre(params, []),
});
export const CDP_ALLOWED_METHODS = Object.freeze(Object.keys(RULES));

/** Throws unless `method` with `params` (and `sessionId`) is allowed. Nothing else may reach the browser. */
export function assertAllowedCommand(method, params, sessionId) {
  if (typeof method !== 'string' || !Object.hasOwn(RULES, method)) refuse(String(method));
  if (!params || typeof params !== 'object' || Array.isArray(params)) refuse(method, '参数无效');
  if (!RULES[method](params)) refuse(method, '参数不允许');
  const page = method === 'Runtime.evaluate';
  if (page ? !isString(sessionId) : sessionId !== undefined) refuse(method, '会话无效');
}

/**
 * A CDP connection over a pipe pair: `output` is the browser's fd 3 (we write), `input` its fd 4 (we read).
 * `send(method, params, sessionId)` resolves with the result or rejects with the browser's error, a timeout or the
 * closed pipe. `onClose(listener)` is called once when the pipe closes or breaks.
 */
export function createCdpPipe({ input, output, timeoutMs = CDP_COMMAND_TIMEOUT_MS, maxFrameBytes = CDP_MAX_FRAME_BYTES }) {
  let nextId = 1, closedWith = null, chunks = [], buffered = 0;
  const pending = new Map();
  const listeners = [];

  function close(error = new Error(PIPE_CLOSED)) {
    if (closedWith) return;
    closedWith = error;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
    chunks = [];
    input.off('data', onData);
    for (const listener of listeners.splice(0)) { try { listener(error); } catch { /* A listener's own failure is not the pipe's. */ } }
  }

  function onFrame(text) {
    let message;
    try { message = JSON.parse(text); } catch { close(new Error(`${PIPE_CLOSED}（收到无法解析的消息）`)); return; }
    // Events (no id) and replies to commands we no longer wait for are ignored.
    if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id) || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(`专用浏览器返回错误：${String(message.error.message ?? 'unknown').slice(0, 300)}`));
    else resolve(message.result ?? {});
  }

  function onData(chunk) {
    let start = 0, end;
    while (!closedWith && (end = chunk.indexOf(0, start)) !== -1) {
      chunks.push(chunk.subarray(start, end));
      const frame = Buffer.concat(chunks).toString('utf8');
      chunks = []; buffered = 0;
      start = end + 1;
      onFrame(frame);
    }
    if (closedWith || start >= chunk.length) return;
    buffered += chunk.length - start;
    if (buffered > maxFrameBytes) { close(new Error(`${PIPE_CLOSED}（消息过大）`)); return; }
    chunks.push(chunk.subarray(start));
  }

  input.on('data', onData);
  for (const stream of [input, output]) {
    stream.once('close', () => close());
    stream.once('end', () => close());
    stream.on('error', () => close());
  }

  return {
    async send(method, params = {}, sessionId) {
      assertAllowedCommand(method, params, sessionId);
      if (closedWith) throw closedWith;
      const id = nextId++;
      const frame = `${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`专用浏览器没有响应：${method}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { output.write(frame); } catch { close(); }
      });
    },
    onClose(listener) { if (closedWith) listener(closedWith); else listeners.push(listener); },
    closed: () => closedWith !== null,
    /** Stops reading and fails every pending command; nothing is written afterwards. */
    dispose() { close(); },
  };
}
