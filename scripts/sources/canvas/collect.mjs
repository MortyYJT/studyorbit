#!/usr/bin/env node
// Canvas collector (moved from scripts/canvas-background.mjs, which remains as a shim; openspec change
// generic-adapters, design §2). `discover <out>` lists the active courses; `<courseId> <out>` reads one course's
// assignment groups and assignments with the owner's submission. Every URL is the configured Canvas origin plus a
// fixed Canvas REST path; pages are read through the browser bridge with the same-origin JSON read, following
// `rel="next"` only within the same origin and path (at most 100 pages). No cookie or token is read.
import { appleEventsHint } from '../../browser/applescript.mjs';
import { withPage } from '../../browser/bridge.mjs';
import { collectorExitCode, httpFailure } from '../../lib/collector-exit.mjs';
import { normalizeCourses, parseCoursePage } from '../../lib/course-list.mjs';
import { bridgeFor, stopFlag, writeJsonAtomic } from '../collector-io.mjs';
import { readSourceConfig } from '../config.mjs';

const [course, dest] = process.argv.slice(2);
if (!(course === 'discover' || /^\d+$/.test(course ?? '')) || !dest) throw new Error('用法：node scripts/canvas-background.mjs <课程ID> <输出路径>');
const config = readSourceConfig({ needsBrowser: true });
const bridge = bridgeFor(config);
const isStopped = stopFlag();
const origin = config.canvasOrigin;
const prefix = `${origin}/api/v1/courses/${course}/`;
const pageSize = Number(process.env.CANVAS_PAGE_SIZE || 100);
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('CANVAS_PAGE_SIZE 必须介于 1 和 100');
const requests = course === 'discover'
  ? [['courses', `${origin}/api/v1/courses?enrollment_state=active&include[]=term&per_page=${pageSize}`]]
  : [['groups', `${prefix}assignment_groups?per_page=${pageSize}`], ['assignments', `${prefix}assignments?include%5B%5D=submission&per_page=${pageSize}`]];
const captured = { courseId: course, capturedAt: new Date().toISOString(), scope: 'paginated', paginationVerified: false, pagination: {} };
const messages = { identity: '无法识别实验标签页', redirect: 'Canvas 登录可能已失效或页面跳转', timeout: 'Canvas 页面加载超时' };

/** One API page: HTTP 429/5xx (or no response) on the final attempt exits with 75 so the sync retries it. */
function acceptPage(text) {
  const response = JSON.parse(text);
  if (response.status !== 200) throw httpFailure('Canvas', response.status);
  return { rows: parseCoursePage(response.body), link: response.link };
}

const start = Date.now();
let closeFailed = false;
try {
  for (const [kind, initialUrl] of requests) {
    const begin = Date.now(), allRows = [], seen = new Set(); let url = initialUrl, pages = 0;
    const expectedPath = initialUrl.split('?')[0];
    while (url) {
      if (isStopped()) throw new Error('已中止');
      if (seen.has(url) || pages >= 100) throw new Error(`${kind} 分页重复或超过上限`);
      seen.add(url);
      const page = await withPage(bridge, url, expectedPath, 'same-origin-json', {
        accept: acceptPage, messages, isAborted: isStopped,
        onCloseError: () => { closeFailed = true; }, closeFailureFails: true,
      });
      allRows.push(...page.rows); pages++;
      const next = (page.link || '').split(',').map(part => part.trim()).find(part => /;\s*rel="?next"?/i.test(part));
      if (next) {
        const match = /^<([^>]+)>/.exec(next);
        if (!match) throw new Error('Canvas 下一页链接格式错误');
        const parsed = new URL(match[1]);
        if (parsed.origin !== origin || parsed.pathname !== new URL(initialUrl).pathname) throw new Error('Canvas 下一页链接不属于当前接口');
        url = parsed.href;
      } else url = null;
    }
    captured.pagination[kind] = { pages, count: allRows.length };
    if (kind === 'courses') { captured.version = 1; captured.source = initialUrl; captured.fetchedAt = new Date().toISOString(); captured.courses = normalizeCourses(allRows, origin); captured.count = captured.courses.length; }
    else if (kind === 'groups') captured.groups = allRows.map(({ id, name, group_weight, rules }) => ({ id, name, group_weight: group_weight ?? null, rules: rules ?? null }));
    else captured.assignments = allRows.map(a => ({ id: a.id, name: a.name ?? null, group_id: a.assignment_group_id ?? null, points_possible: a.points_possible ?? null, due_at: a.due_at ?? null, unlock_at: a.unlock_at ?? null, html_url: a.html_url ?? null, submission: a.submission ? { score: a.submission.score ?? null, workflow_state: a.submission.workflow_state ?? null, submitted_at: a.submission.submitted_at ?? null } : null }));
    captured[`${kind}Ms`] = Date.now() - begin;
  }
  captured.paginationVerified = true;
  if (isStopped()) throw new Error('已中止');
  captured.durationMs = Date.now() - start;
  await writeJsonAtomic(dest, captured);
  console.log(JSON.stringify({ courses: captured.courses?.length, groups: captured.groups?.length, assignments: captured.assignments?.length, durationMs: captured.durationMs }));
} catch (error) {
  const message = String(error.stderr || error.message).trim().slice(0, 500);
  console.error(`Canvas 后台采集失败：${message}。${appleEventsHint(config.browser)}`);
  process.exitCode = collectorExitCode(error);
} finally {
  // Reported after the failure itself, as before the move.
  if (closeFailed) console.error('无法关闭本次后台采集标签页，请手动关闭。');
  await bridge.dispose();
}
