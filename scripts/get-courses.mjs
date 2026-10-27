#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { filterSubjects, parseCoursePage, normalizeCourses } from './lib/course-list.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=100';
const browsers = {
  edge: 'com.microsoft.edgemac', chrome: 'com.google.Chrome', safari: 'com.apple.Safari',
  firefox: 'org.mozilla.firefox', brave: 'com.brave.Browser',
};
const help = `获取已登录浏览器中的 Canvas 课程列表（Mac 验证版）

  npm run sync:courses
  npm run sync:courses -- --browser edge
  npm run sync:courses -- --browser chrome --wait 3

--browser   default（默认） / edge / chrome / safari / firefox / brave
--wait      打开页面后等待秒数，默认 1；之后只复制一次
--out       输出 JSON 文件，默认 .local/lms/courses.json

请先在所选浏览器登录 LMS；运行期间不要操作键盘或切换窗口。
使用当前浏览器的普通打开链接行为，不创建专用配置；浏览器多配置用户须确认打开的是已登录配置。
脚本使用剪贴板并尝试恢复原有纯文本，不保留图片或富文本格式。
首次可能需在系统设置授予启动脚本的终端“辅助功能”和“自动化”权限。
目前仅 Mac 自动化已实现，其他浏览器的实际兼容性需要逐一测试。`;

async function command(binary, args, options = {}) {
  const result = await exec(binary, args, { timeout: 10000, maxBuffer: 10 * 1024 * 1024, ...options });
  return result.stdout;
}
async function clipboard() { return command('/usr/bin/pbpaste', []); }
async function copyText(text) {
  await new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/pbcopy', [], { timeout: 5000 }, error => error ? reject(error) : resolve());
    child.stdin.on('error', reject);
    child.stdin.end(text);
  });
}
async function defaultBrowser() {
  return (await command('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
    'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://canvas.lms.unimelb.edu.au/")); if (!u) throw new Error("No default browser"); $.NSBundle.bundleWithURL(u).bundleIdentifier.js;'])).trim();
}

// Only sends keys if the selected browser is frontmost. Never reads cookies or evaluates page scripts.
const selectAndCopy = `on run argv
  tell application "System Events"
    set activeId to bundle identifier of first application process whose frontmost is true
    if activeId is not (item 1 of argv) then error "BROWSER_NOT_FRONTMOST"
    keystroke "l" using command down
    delay 0.1
    key code 53
    delay 0.1
    keystroke "a" using command down
    delay 0.1
    keystroke "c" using command down
  end tell
end run`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const options = { browser: 'default', wait: '1', out: resolve(root, '.local/lms/courses.json') };
  while (args.length) {
    const key = args.shift();
    if (!['--browser', '--wait', '--out'].includes(key) || !args.length || args[0].startsWith('--')) {
      throw new Error('参数无效。运行 npm run sync:courses -- --help 查看用法。');
    }
    options[key.slice(2)] = args.shift();
  }
  if (process.platform !== 'darwin') throw new Error('这版脚本只实现了 Mac 操作；Windows 适配尚未实现。');
  if (options.browser !== 'default' && !browsers[options.browser]) throw new Error('不支持的浏览器名称，请查看 --help。');
  const seconds = Number(options.wait);
  if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 120) throw new Error('--wait 必须在 0.2–120 秒之间。');
  const bundle = options.browser === 'default' ? await defaultBrowser() : browsers[options.browser];
  console.log(`使用浏览器：${options.browser} (${bundle})`);
  console.log('打开课程 API，仅读取一次第一页（与旧扩展一致）。请保持浏览器前台。');
  const started = Date.now();
  const previous = await clipboard();
  let ownedClipboard;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let items;
  const runId = randomUUID();
  try {
    await command('/usr/bin/open', ['-b', bundle, base]);
    await pause(seconds * 1000);
    if (stopped) throw new Error('已停止。');
    const marker = `coursework-copy-${runId}`;
    ownedClipboard = marker;
    await copyText(marker);
    try {
      await command('/usr/bin/osascript', ['-e', selectAndCopy, bundle]);
    } catch (error) {
      if (String(error.stderr).includes('BROWSER_NOT_FRONTMOST')) throw new Error('浏览器不在前台，已停止。请重新运行后保持浏览器在前台。');
      const detail = String(error.stderr || error.message).trim().slice(0, 1000);
      throw new Error(`复制操作失败。底层错误：${detail}\n若包含“不允许辅助访问 / not allowed assistive access / 1002”，检查辅助功能权限；若为“not authorized / 1743”，检查自动化权限。`);
    }
    await pause(100);
    const text = await clipboard();
    ownedClipboard = text;
    if (text === marker) throw new Error('没有复制到页面内容，已停止，没有自动重试。');
    if (/^https?:\/\//.test(text.trim())) throw new Error('复制到的是地址栏，未取得页面正文，已停止，没有自动重试。');
    try { items = parseCoursePage(text); }
    catch (error) { throw new Error(`${error.message} 此次只读取一次，没有自动重试。若页面尚未加载，可下次加 --wait 3。`); }
  } finally {
    // Do not replace clipboard text the user changed after the last copy.
    if (ownedClipboard !== undefined && await clipboard() === ownedClipboard) await copyText(previous);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  if (stopped) throw new Error('已停止。');
  const courses = normalizeCourses(items);
  const output = resolve(options.out);
  const result = { version: 1, source: base, browser: bundle, fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - started, attempts: 1, scope: 'first_page', paginationVerified: false, count: courses.length, courses };
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${runId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  const subjects = filterSubjects(courses);
  console.log(`\n获取 ${courses.length} 个候选项，筛出 ${subjects.length} 门课程，用时 ${(result.durationMs / 1000).toFixed(1)} 秒：`);
  for (const course of subjects) console.log(`- ${course.subjectCode} | ${course.name}${course.term ? ` | ${course.term}` : ''}`);
  console.log(`\n结果已保存：${output}`);
  console.log('仅读取第一页，未验证分页完整性；原始候选项保留在结果文件中。');
  if (items.length >= 100) console.log('注意：本页达到 100 条，可能还有下一页；这里的数量不是全部课程总数。');
}

main().catch(error => { console.error(`\n获取失败：${error.message}`); process.exitCode = 1; });
