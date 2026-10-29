#!/usr/bin/env node
// UniMelb Handbook collector (moved from scripts/collect-handbook.mjs, which remains as a shim; openspec change
// generic-adapters, design §4). `<CODE> <year> <out>` reads the body text of the subject's assessment page for that
// year in a background tab through the browser bridge.
import { withPage } from '../../browser/bridge.mjs';
import { collectorExitCode, httpFailure, isTemporaryStatus } from '../../lib/collector-exit.mjs';
import { bridgeFor, stopFlag, writeJsonAtomic } from '../../sources/collector-io.mjs';
import { readSourceConfig } from '../../sources/config.mjs';
import { unimelb } from './index.mjs';
import { HANDBOOK_ORIGIN } from './handbook-source.mjs';

const [course, year, dest] = process.argv.slice(2);
if (!unimelb.isSubjectCode(course) || !/^20\d{2}$/.test(year ?? '') || !dest) throw new Error('用法：node scripts/collect-handbook.mjs <课程代码> <学年> <输出路径>');
let config, bridge;
try { config = readSourceConfig({ needsBrowser: true }); bridge = bridgeFor(config); }
catch (error) { console.error(`Handbook 采集不可用：${error.message}`); process.exit(1); }
const isStopped = stopFlag();
const url = `${HANDBOOK_ORIGIN}/${year}/subjects/${course.toLowerCase()}/assessment`;
const start = Date.now();
let closeFailed = false;
try {
  const content = await withPage(bridge, url, url, 'body-text', {
    messages: { identity: '无法识别 Handbook 标签页', redirect: 'Handbook 页面跳转或不可访问', timeout: 'Handbook 页面加载超时' },
    isAborted: isStopped,
    accept(text) {
      if (!text || !text.toLowerCase().includes(course.toLowerCase()) || !/assessment/i.test(text)) throw new Error('Handbook 页面未显示考核内容');
      return text;
    },
    // HTTP 429/5xx on the final attempt exits with 75 so the sync retries it (design §9); an unknown status stays 1.
    async onUnread(tab) {
      const status = Number(await bridge.read(tab, url, 'navigation-status').catch(() => ''));
      if (!isStopped() && isTemporaryStatus(status)) throw httpFailure('Handbook', status);
    },
    onCloseError: () => { closeFailed = true; },
  });
  const result = { status: 'available', course, year, url, text: content.slice(0, 50000), capturedAt: new Date().toISOString(), durationMs: Date.now() - start };
  await writeJsonAtomic(dest, result);
  console.log(JSON.stringify({ status: 'available', durationMs: result.durationMs }));
} catch (e) { console.error(`Handbook 采集不可用：${String(e.stderr || e.message).trim().slice(0, 400)}`); process.exitCode = collectorExitCode(e); }
finally {
  // Reported after the result or the failure, as before the move; a failed close never loses the page text.
  if (closeFailed) console.error('无法关闭 Handbook 后台标签页，请手动关闭。');
  await bridge.dispose();
}
