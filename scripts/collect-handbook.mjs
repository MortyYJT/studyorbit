#!/usr/bin/env node
// Edge/macOS experiment. Opens a private working tab, then restores the previously active tab.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile), wait = ms => new Promise(r => setTimeout(r, ms));
const [course, year, dest] = process.argv.slice(2);
if (process.platform !== 'darwin' || !/^[A-Z]{4}[1-9]\d{4}$/.test(course ?? '') || !/^20\d{2}$/.test(year ?? '') || !dest) throw new Error('用法：node scripts/collect-handbook.mjs <课程代码> <学年> <输出路径>');
const run = async (script, args) => (await exec('/usr/bin/osascript', ['-e', script, ...args], { timeout: 15000, maxBuffer: 24 * 1024 * 1024 })).stdout.trim();
const create = `on run argv
 tell application "Microsoft Edge"
  if (count of windows) is 0 then error "EDGE_WINDOW_MISSING"
  set w to front window
  set previousTab to active tab of w
  set previousIndex to active tab index of w
  set previousId to id of previousTab
  set targetTab to make new tab at end of tabs of w with properties {URL:item 1 of argv}
  set targetId to id of targetTab
  if id of active tab of w is targetId then set active tab index of w to previousIndex
  return (id of w as text) & ":" & targetId
 end tell
end run`;
const status = `on run argv
 tell application "Microsoft Edge"
  set w to first window whose id is (item 1 of argv as integer)
  set t to first tab of w whose id is (item 2 of argv)
  if URL of t does not start with (item 3 of argv) then return "redirect"
  if loading of t then return "loading"
  return "ready"
 end tell
end run`;
const read = `on run argv
 tell application "Microsoft Edge"
  set w to first window whose id is (item 1 of argv as integer)
  set t to first tab of w whose id is (item 2 of argv)
  if URL of t does not start with (item 3 of argv) then error "UNEXPECTED_URL"
  if loading of t then error "PAGE_STILL_LOADING"
  return execute t javascript "document.body ? document.body.innerText : ''"
 end tell
end run`;
const close = `on run argv
 tell application "Microsoft Edge"
  set w to first window whose id is (item 1 of argv as integer)
  set t to first tab of w whose id is (item 2 of argv)
  close t
 end tell
end run`;
let target, interrupted = false;
process.on('SIGTERM', () => { interrupted = true; });
process.on('SIGINT', () => { interrupted = true; });
const url = `https://handbook.unimelb.edu.au/${year}/subjects/${course.toLowerCase()}/assessment`;
const start = Date.now();
try {
  const identity = (await run(create, [`${url}#coursework-${randomUUID()}`])).split(':');
  if (identity.length !== 2 || !/^\d+$/.test(identity[0]) || !identity[1]) throw new Error('无法识别 Handbook 标签页');
  target = identity; const until = Date.now() + 20000; let ready = false;
  while (Date.now() < until && !interrupted) { const state = await run(status, [...target, url]); if (state === 'redirect') throw new Error('Handbook 页面跳转或不可访问'); if (state === 'ready') { ready = true; break; } await wait(250); }
  if (!ready) throw new Error(interrupted ? '已中止' : 'Handbook 页面加载超时');
  let content = '', error;
  for (let attempt=0; attempt<2 && !interrupted; attempt++) {
    try { if(attempt) await wait(500); content = await run(read, [...target, url]); if (!content.toLowerCase().includes(course.toLowerCase()) || !/assessment/i.test(content)) throw new Error('Handbook 页面未显示考核内容'); break; }
    catch (e) { error=e; content=''; }
  }
  if (!content) throw error ?? new Error('已中止');
  const path = resolve(dest), tmp = `${path}.${randomUUID()}.tmp`;
  const result = { status:'available', course, year, url, text:content.slice(0,50000), capturedAt:new Date().toISOString(), durationMs:Date.now()-start };
  await mkdir(dirname(path), { recursive:true, mode:0o700 }); await writeFile(tmp, `${JSON.stringify(result,null,2)}\n`, {mode:0o600}); await rename(tmp,path);
  console.log(JSON.stringify({ status:'available', durationMs:result.durationMs }));
} catch (e) { console.error(`Handbook 采集不可用：${String(e.stderr || e.message).trim().slice(0,400)}`); process.exitCode=1; }
finally { if(target) await run(close,target).catch(()=>console.error('无法关闭 Handbook 后台标签页，请手动关闭。')); }
