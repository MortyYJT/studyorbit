#!/usr/bin/env node
import { getCookies, toCookieHeader } from '@steipete/sweet-cookie';
import { filterSubjects, normalizeCourses, parseCoursePage } from './lib/course-list.mjs';

const url = 'https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=100';
const help = `Canvas 浏览器登录会话读取实验

  npm run experiment:cookie
  npm run experiment:cookie -- --browser edge --profile "Profile 1"

--browser  edge（默认）、chrome、firefox、safari
--profile  指定浏览器配置目录或名称；不指定时使用库的默认配置

本实验不启动浏览器、不使用 Agent、不修改现有同步结果。
只向 Canvas 课程接口发送读取到的 Cookie，不显示或保存 Cookie 的值。
读取浏览器数据库和解密过程可能触发系统钥匙串或其他权限提示。
Cookie 库可能临时复制浏览器数据库；首次验证不保证所有浏览器均可读取。`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  let browser = 'edge';
  let profile;
  while (args.length) {
    const option = args.shift();
    if (!['--browser', '--profile'].includes(option) || !args.length || args[0].startsWith('--')) {
      throw new Error('参数无效，可用 npm run experiment:cookie -- --help 查看用法。');
    }
    if (option === '--browser') browser = args.shift();
    else profile = args.shift();
  }
  if (!['edge', 'chrome', 'firefox', 'safari'].includes(browser)) throw new Error('浏览器请使用 edge、chrome、firefox 或 safari。');
  if (browser === 'safari' && profile) throw new Error('此实验尚未提供 Safari 配置选择。');
  const started = performance.now();
  console.log(`浏览器：${browser}${profile ? `，配置：${profile}` : '（默认配置）'}`);
  console.log('正在读取 Canvas 登录会话；如果出现钥匙串提示，请根据系统提示操作。');
  let result;
  try {
    result = await getCookies({
      url, browsers: [browser], mode: 'first', timeoutMs: 30000,
      ...(profile && browser === 'edge' ? { edgeProfile: profile } : {}),
      ...(profile && browser === 'chrome' ? { chromeProfile: profile } : {}),
      ...(profile && browser === 'firefox' ? { firefoxProfile: profile } : {}),
    });
  } catch {
    throw new Error('读取浏览器 Cookie 失败，请检查浏览器配置和系统访问权限。');
  }
  const readMs = performance.now() - started;
  // Library warnings contain no cookie values; do not print cookie names, values, or request headers.
  for (const warning of result.warnings ?? []) console.warn(`读取提示：${warning}`);
  if (!result.cookies.length) throw new Error('没有读取到适用于 Canvas 课程接口的 Cookie。请确认浏览器配置已登录，或检查权限。');
  console.log(`浏览器数据读取完成：${readMs.toFixed(0)} ms`);
  const requestStarted = performance.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET', headers: { Cookie: toCookieHeader(result.cookies) },
      redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('无法连接 Canvas 课程接口，请检查网络后再试。');
  }
  if (response.status >= 300 && response.status < 400) throw new Error(`Canvas 返回 HTTP ${response.status} 跳转，登录状态可能无效。`);
  if (!response.ok) throw new Error(`Canvas 接口返回 HTTP ${response.status}，未获得课程数据。`);
  const responseText = await response.text();
  let items;
  try { items = parseCoursePage(responseText); }
  catch { throw new Error('Canvas 响应不是预期课程 JSON；浏览器 Cookie 可能不完整或登录状态无效。'); }
  const requestMs = performance.now() - requestStarted;
  const courses = filterSubjects(normalizeCourses(items));
  console.log(`Canvas 请求及解析：${requestMs.toFixed(0)} ms`);
  console.log(`总耗时：${(performance.now() - started).toFixed(0)} ms`);
  console.log(`接口第一页：${items.length} 个候选项，筛出 ${courses.length} 门课程`);
  for (const course of courses) console.log(`- ${course.subjectCode} | ${course.name}`);
  console.log('实验没有修改同步结果；是否完整覆盖全部课程仍未验证。');
}

main().catch(error => { console.error(`实验失败：${error.message}`); process.exitCode = 1; });
