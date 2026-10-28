#!/usr/bin/env node
// Edge/macOS experiment. Opens a private working tab, then restores the previously active tab.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCoursePage, normalizeCourses } from './lib/course-list.mjs';
const exec = promisify(execFile), wait = ms => new Promise(r => setTimeout(r, ms));
const [course, dest] = process.argv.slice(2);
if (process.platform !== 'darwin' || !(course === 'discover' || /^\d+$/.test(course ?? '')) || !dest) throw new Error('用法：node scripts/canvas-background.mjs <课程ID> <输出路径>');
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
const prefix = `https://canvas.lms.unimelb.edu.au/api/v1/courses/${course}/`;
const requests = course === 'discover' ? [['courses', 'https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=100']] : [['groups', `${prefix}assignment_groups?per_page=100`], ['assignments', `${prefix}assignments?include%5B%5D=submission&per_page=100`]];
const captured = { courseId: course, capturedAt: new Date().toISOString(), scope: 'first_page', paginationVerified: false };
const start = Date.now();
try {
  for (const [kind, url] of requests) {
    if (interrupted) throw new Error('已中止');
    const begin = Date.now(), marker = randomUUID(), targetUrl = `${url}#coursework-${marker}`;
    const identity = (await run(create, [targetUrl])).split(':');
    if (identity.length !== 2 || !/^\d+$/.test(identity[0]) || !identity[1]) throw new Error('无法识别实验标签页');
    target = identity;
    const expectedPath = url.split('?')[0];
    const until = Date.now() + 20000; let ready = false;
    while (Date.now() < until && !interrupted) {
      const state = await run(status, [...target, expectedPath]);
      if (state === 'redirect') throw new Error('Canvas 登录可能已失效或页面跳转');
      if (state === 'ready') { ready = true; break; }
      await wait(250);
    }
    if (!ready) throw new Error(interrupted ? '已中止' : 'Canvas 页面加载超时');
    let rows, err;
    for (let attempt = 0; attempt < 2 && !interrupted; attempt++) {
      try { if (attempt) await wait(500); rows = parseCoursePage(await run(read, [...target, expectedPath])); break; }
      catch (error) { err = error; }
    }
    if (!rows) throw err ?? new Error('已中止');
    if (kind === 'courses') { captured.version = 1; captured.source = url; captured.fetchedAt = new Date().toISOString(); captured.courses = normalizeCourses(rows); captured.count = captured.courses.length; }
    else if (kind === 'groups') captured.groups = rows.map(({ id, name, group_weight, rules }) => ({ id, name, group_weight: group_weight ?? null, rules: rules ?? null }));
    else captured.assignments = rows.map(a => ({ id: a.id, name: a.name ?? null, group_id: a.assignment_group_id ?? null, points_possible: a.points_possible ?? null, due_at: a.due_at ?? null, unlock_at: a.unlock_at ?? null, html_url: a.html_url ?? null, submission: a.submission ? { score: a.submission.score ?? null, workflow_state: a.submission.workflow_state ?? null, submitted_at: a.submission.submitted_at ?? null } : null }));
    captured[`${kind}Ms`] = Date.now() - begin;
    await run(close, target); target = undefined;
  }
  if (interrupted) throw new Error('已中止');
  captured.durationMs = Date.now() - start;
  const path = resolve(dest), tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tmp, `${JSON.stringify(captured, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, path);
  console.log(JSON.stringify({ courses: captured.courses?.length, groups: captured.groups?.length, assignments: captured.assignments?.length, durationMs: captured.durationMs }));
} catch (error) {
  const message = String(error.stderr || error.message).trim().slice(0, 500);
  console.error(`Canvas 后台采集失败：${message}。如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。`);
  process.exitCode = 1;
} finally {
  if (target) await run(close, target).catch(() => console.error('无法关闭本次后台采集标签页，请手动关闭。'));
}
