#!/usr/bin/env node
// Canvas preflight (sync-incomplete fix 2, decision #484): before a sync collects anything, one authenticated
// same-origin request to the configured Canvas origin's `/api/v1/users/self` through the configured browser bridge.
// It checks that the browser runs and has a window, that Apple Events JavaScript works (AppleScript bridges) and that
// Canvas is signed in. The response body is never printed, written or kept; no cookie or token is read. Exit codes
// as the Canvas collector: 0 ready, 75 temporary (HTTP 429/5xx), 77 the dedicated browser is signed out, 1 otherwise.
import { appleEventsHint } from '../../browser/applescript.mjs';
import { withPage } from '../../browser/bridge.mjs';
import { CDP_SIGN_IN } from '../../browser/cdp.mjs';
import { collectorExitCode, EX_SIGN_IN, httpFailure } from '../../lib/collector-exit.mjs';
import { bridgeFor, stopFlag } from '../collector-io.mjs';
import { readSourceConfig } from '../config.mjs';

let config, bridge;
try { config = readSourceConfig({ needsBrowser: true }); bridge = bridgeFor(config); }
catch (error) { console.error(`Canvas 后台采集失败：${error.message}`); process.exit(1); }
const isStopped = stopFlag();
const dedicated = config.browser.startsWith('cdp-');
const url = `${config.canvasOrigin}/api/v1/users/self`;
const messages = { identity: '无法识别实验标签页', redirect: dedicated ? CDP_SIGN_IN : 'Canvas 登录可能已失效或页面跳转', timeout: 'Canvas 页面加载超时' };

/** Only the HTTP status is looked at. */
function accept(text) {
  const { status } = JSON.parse(text);
  if (dedicated && status === 401) throw new Error(CDP_SIGN_IN);
  if (status !== 200) throw httpFailure('Canvas', status);
  return true;
}

let closeFailed = false;
try {
  await withPage(bridge, url, url, 'same-origin-json', { accept, messages, isAborted: isStopped, onCloseError: () => { closeFailed = true; } });
  console.log('ok');
} catch (error) {
  const message = String(error.stderr || error.message).trim().slice(0, 500);
  console.error(`Canvas 后台采集失败：${message}。${appleEventsHint(config.browser)}`);
  process.exitCode = dedicated && error.message === CDP_SIGN_IN ? EX_SIGN_IN : collectorExitCode(error);
} finally {
  if (closeFailed) console.error('无法关闭本次后台采集标签页，请手动关闭。');
  await bridge.dispose();
}
