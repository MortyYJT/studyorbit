#!/usr/bin/env node
// Edge/macOS experiment. Opens a private working tab, then restores the previously active tab.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCoursePage, normalizeCourses } from './lib/course-list.mjs';
import { collectorExitCode, httpFailure } from './lib/collector-exit.mjs';
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
  return execute t javascript (item 4 of argv)
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
const pageSize = Number(process.env.CANVAS_PAGE_SIZE || 100);
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('CANVAS_PAGE_SIZE 必须介于 1 和 100');
const requests = course === 'discover' ? [['courses', `https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=${pageSize}`]] : [['groups', `${prefix}assignment_groups?per_page=${pageSize}`], ['assignments', `${prefix}assignments?include%5B%5D=submission&per_page=${pageSize}`]];
const captured = { courseId: course, capturedAt: new Date().toISOString(), scope: 'paginated', paginationVerified: false, pagination: {} };
// Same-origin request exposes Canvas Link headers; no credentials leave the browser.
const readPage = `(() => { const xhr = new XMLHttpRequest(); xhr.open('GET', location.href.split('#')[0], false); xhr.send(); return JSON.stringify({ status: xhr.status, body: xhr.responseText, link: xhr.getResponseHeader('Link') }); })()`;
const start = Date.now();
try {
  for (const [kind, initialUrl] of requests) {
    const begin = Date.now(), allRows = [], seen = new Set(); let url = initialUrl, pages = 0;
    const expectedPath = initialUrl.split('?')[0];
    while (url) {
      if (interrupted) throw new Error('已中止');
      if (seen.has(url) || pages >= 100) throw new Error(`${kind} 分页重复或超过上限`);
      seen.add(url);
      const identity = (await run(create, [`${url}#coursework-${randomUUID()}`])).split(':');
      if (identity.length !== 2 || !/^\d+$/.test(identity[0]) || !identity[1]) throw new Error('无法识别实验标签页');
      target = identity;
      const until = Date.now() + 20000; let ready = false;
      while (Date.now() < until && !interrupted) {
        const state = await run(status, [...target, expectedPath]);
        if (state === 'redirect') throw new Error('Canvas 登录可能已失效或页面跳转');
        if (state === 'ready') { ready = true; break; }
        await wait(250);
      }
      if (!ready) throw new Error(interrupted ? '已中止' : 'Canvas 页面加载超时');
      let response, rows, err;
      for (let attempt = 0; attempt < 2 && !interrupted; attempt++) {
        try {
          if (attempt) await wait(500);
          response = JSON.parse(await run(read, [...target, expectedPath, readPage]));
          // HTTP 429/5xx (or no response) on the final attempt exits with 75 so the sync retries it (design §9).
          if (response.status !== 200) throw httpFailure('Canvas', response.status);
          rows = parseCoursePage(response.body); break;
        } catch (error) { err = error; }
      }
      if (!rows) throw err ?? new Error('已中止');
      allRows.push(...rows); pages++;
      const next = (response.link || '').split(',').map(part => part.trim()).find(part => /;\s*rel="?next"?/i.test(part));
      if (next) {
        const match = /^<([^>]+)>/.exec(next);
        if (!match) throw new Error('Canvas 下一页链接格式错误');
        const parsed = new URL(match[1]);
        if (parsed.origin !== 'https://canvas.lms.unimelb.edu.au' || parsed.pathname !== new URL(initialUrl).pathname) throw new Error('Canvas 下一页链接不属于当前接口');
        url = parsed.href;
      } else url = null;
      await run(close, target); target = undefined;
    }
    captured.pagination[kind] = { pages, count: allRows.length };
    if (kind === 'courses') { captured.version = 1; captured.source = initialUrl; captured.fetchedAt = new Date().toISOString(); captured.courses = normalizeCourses(allRows); captured.count = captured.courses.length; }
    else if (kind === 'groups') captured.groups = allRows.map(({ id, name, group_weight, rules }) => ({ id, name, group_weight: group_weight ?? null, rules: rules ?? null }));
    else captured.assignments = allRows.map(a => ({ id: a.id, name: a.name ?? null, group_id: a.assignment_group_id ?? null, points_possible: a.points_possible ?? null, due_at: a.due_at ?? null, unlock_at: a.unlock_at ?? null, html_url: a.html_url ?? null, submission: a.submission ? { score: a.submission.score ?? null, workflow_state: a.submission.workflow_state ?? null, submitted_at: a.submission.submitted_at ?? null } : null }));
    captured[`${kind}Ms`] = Date.now() - begin;
  }
  captured.paginationVerified = true;
  if (interrupted) throw new Error('已中止');
  captured.durationMs = Date.now() - start;
  const path = resolve(dest), tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tmp, `${JSON.stringify(captured, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, path);
  console.log(JSON.stringify({ courses: captured.courses?.length, groups: captured.groups?.length, assignments: captured.assignments?.length, durationMs: captured.durationMs }));
} catch (error) {
  const message = String(error.stderr || error.message).trim().slice(0, 500);
  console.error(`Canvas 后台采集失败：${message}。如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。`);
  process.exitCode = collectorExitCode(error);
} finally {
  if (target) await run(close, target).catch(() => console.error('无法关闭本次后台采集标签页，请手动关闭。'));
}
