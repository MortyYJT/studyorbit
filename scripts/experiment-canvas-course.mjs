#!/usr/bin/env node
// macOS prototype: read Canvas JSON through the user's current default browser.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCoursePage } from './lib/course-list.mjs';
const exec = promisify(execFile);
const pause = ms => new Promise(r => setTimeout(r, ms));
const course = process.argv[2];
if (process.platform !== 'darwin' || !/^\d+$/.test(course ?? '')) throw new Error('用法：node scripts/experiment-canvas-course.mjs <Canvas课程ID>（macOS）');
const run = async (bin, args) => (await exec(bin, args, { timeout: 12000, maxBuffer: 24 * 1024 * 1024 })).stdout;
const copy = async value => new Promise((resolveCopy, reject) => { const p = spawn('/usr/bin/pbcopy'); p.on('error', reject); p.on('close', code => code === 0 ? resolveCopy() : reject(new Error('剪贴板写入失败'))); p.stdin.end(value); });
const browser = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://canvas.lms.unimelb.edu.au/")); if (!u) throw new Error("No default browser"); $.NSBundle.bundleWithURL(u).bundleIdentifier.js;'])).trim();
const select = `on run argv
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
const close = `on run argv
 tell application "System Events"
  set activeId to bundle identifier of first application process whose frontmost is true
  if activeId is not (item 1 of argv) then error "BROWSER_NOT_FRONTMOST"
  keystroke "l" using command down
  delay 0.1
  keystroke "c" using command down
  delay 0.1
  set currentAddress to the clipboard as text
  if currentAddress starts with (item 2 of argv) and currentAddress contains (item 3 of argv) then
   keystroke "w" using command down
  else
   key code 53
   error "CAPTURE_TAB_NOT_ACTIVE"
  end if
 end tell
end run`;
const prefix = `https://canvas.lms.unimelb.edu.au/api/v1/courses/${course}/`;
const requests = [ ['groups', `${prefix}assignment_groups?per_page=100`], ['assignments', `${prefix}assignments?include%5B%5D=submission&per_page=100`] ];
const started = Date.now(), original = await run('/usr/bin/pbpaste', []), id = randomUUID();
let owned, activeMarker, captured = {};
try {
  for (const [kind, url] of requests) {
    const begin = Date.now(), marker = `coursework-${id}-${kind}`;
    console.log(`读取 ${kind}，请保持浏览器在前台…`);
    await run('/usr/bin/open', ['-b', browser, `${url}#${marker}`]); activeMarker = marker;
    await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application id (item 1 of argv) to activate', '-e', 'end run', browser]);
    await pause(3000);
    await copy(marker); owned = marker;
    await run('/usr/bin/osascript', ['-e', select, browser]);
    await pause(100);
    const text = await run('/usr/bin/pbpaste', []); owned = text;
    if (text === marker) throw new Error('未复制到页面，浏览器可能仍在加载。');
    const rows = parseCoursePage(text);
    if (kind === 'groups') captured.groups = rows.map(({ id, name, group_weight, rules }) => ({ id, name, group_weight: group_weight ?? null, rules: rules ?? null }));
    else captured.assignments = rows.map(a => ({ id: a.id, name: a.name ?? null, group_id: a.assignment_group_id ?? null, points_possible: a.points_possible ?? null, due_at: a.due_at ?? null, unlock_at: a.unlock_at ?? null, html_url: a.html_url ?? null, submission: a.submission ? { score: a.submission.score ?? null, workflow_state: a.submission.workflow_state ?? null, submitted_at: a.submission.submitted_at ?? null } : null }));
    captured[`${kind}Ms`] = Date.now() - begin;
    const closeMarker = `close-${id}`; await copy(closeMarker); owned = closeMarker;
    try { await run('/usr/bin/osascript', ['-e', close, browser, prefix, marker]); activeMarker = undefined; owned = await run('/usr/bin/pbpaste', []); }
    catch { console.error(`无法确认实验标签页，未自动关闭 ${kind} 标签。`); owned = await run('/usr/bin/pbpaste', []); }
    console.log(`${kind}：${rows.length} 条，用时 ${captured[`${kind}Ms`]} ms`);
  }
  const out = resolve('.local', 'experiments', 'hybrid-03', `canvas-auto-${course}.json`);
  const result = { courseId: course, capturedAt: new Date().toISOString(), scope: 'first_page', paginationVerified: false, browser, durationMs: Date.now() - started, ...captured };
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const tmp = `${out}.${id}.tmp`; await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, out);
  console.log(`已保存实验数据：${out}（仅第一页，分页未验证）`);
} catch (error) {
  if (activeMarker) {
    try { await run('/usr/bin/osascript', ['-e', close, browser, prefix, activeMarker]); owned = await run('/usr/bin/pbpaste', []); }
    catch { console.error('未能安全关闭本次实验标签页，请手动关闭。'); }
  }
  const detail = String(error.stderr || error.message).trim().slice(0, 500);
  console.error(`采集失败：${detail}。未更新实验结果；检查浏览器登录、辅助功能与自动化权限。`); process.exitCode = 1;
} finally {
  const current = await run('/usr/bin/pbpaste', []).catch(() => null);
  if (owned !== undefined && current === owned) await copy(original).catch(() => {});
}
