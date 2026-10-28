#!/usr/bin/env node
// Read-only lesson inventory and final-submission scores from the user's edstem-cli account.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const [code, term, dest] = process.argv.slice(2);
if (!/^[A-Z]{4}[1-9]\d{4}$/.test(code ?? '') || !dest) throw new Error('Missing course code or output path');
const year = /\b(20\d{2})\b/.exec(term ?? '')?.[1];
const semester = /(?:semester|sem)\s*([12])/i.exec(term ?? '')?.[1];
if (!year || !semester) throw new Error('无法确定 Ed 的年份与学期');
const cli = async (command, args) => JSON.parse((await exec(command, args, { timeout: 60000, maxBuffer: 12 * 1024 * 1024 })).stdout);
const units = await cli('edstem', ['units', 'list', '--json']);
if (!Array.isArray(units)) throw new Error('Ed 课程列表格式错误');
const matches = units.filter(u => typeof u.code === 'string' && u.code.toUpperCase().match(new RegExp(`^${code}(?![A-Z0-9])`)) && String(u.year) === year && new RegExp(`(?:semester|sem)\\s*${semester}\\b`, 'i').test(String(u.session)));
if (matches.length > 1) throw new Error('Ed 存在多个相同学期课程，无法自动确定');
let result;
if (!matches.length) result = { status: 'not_found', code, term, lessons: [], scores: [] };
else {
  const unit = String(matches[0].id);
  if (!/^\d+$/.test(unit)) throw new Error('Ed 课程 ID 错误');
  const data = await cli('edstem', ['lessons', 'list', unit, '--json', '--module', 'all', '--state', 'all', '--status', 'all']);
  if (!Array.isArray(data)) throw new Error('Ed 课程目录格式错误');
  const lessons = data.filter(l => String(l.courseId) === unit).map(l => ({ id: String(l.id), title: l.title, module: l.moduleName ?? null, due: l.dueAt ?? null, status: l.status ?? null, url: `https://edstem.org/au/courses/${unit}/lessons/${l.id}` }));
  const allCandidates = lessons.filter(l => /assignment|assessment|project/i.test(`${l.module ?? ''} ${l.title ?? ''}`) && /^\d+$/.test(l.id));
  const candidates = allCandidates.slice(0, 50);
  let scores = [], scoresError = null;
  if (candidates.length) {
    try { const result = await cli(process.execPath, [fileURLToPath(new URL('./edstem-scores.mjs', import.meta.url)), ...candidates.map(x => x.id)]); scores = result.results ?? []; }
    catch { scoresError = '部分 Ed 成绩读取不可用'; }
  }
  // Fetch a small number of course/first-workshop introductions, not assignment bodies.
  const intro = lessons.find(l => /subject information|subject overview|course overview|subject introduction/i.test(l.title ?? ''));
  const workshop = lessons.find(l => /workshop|tutorial/i.test(`${l.module ?? ''} ${l.title ?? ''}`) && /week\s*0?1\b/i.test(l.title ?? ''));
  const targets = [...new Map([intro, workshop].filter(Boolean).map(l => [l.id, l])).values()];
  const context = []; let contextError = false;
  for (const lesson of targets) {
    try {
      const detail = await cli('edstem', ['lessons', 'show', lesson.id, '--json']);
      const slides = Array.isArray(detail.slides) ? detail.slides : [];
      const candidates = slides.filter(slide => /subject overview|course overview|assessment (?:overview|information)|workshop introduction|welcome to .*workshop/i.test(slide.title ?? '')).slice(0, 3);
      for (const slide of candidates) {
        if (!/^\d+$/.test(String(slide.id))) continue;
        const content = await cli('edstem', ['slides', 'show', String(slide.id), '--json']);
        if (String(content.lessonId) !== lesson.id || String(content.courseId) !== unit || typeof content.content !== 'string') continue;
        const text = content.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
        context.push({ lessonId: lesson.id, lessonTitle: lesson.title, slideId: String(slide.id), slideTitle: slide.title, text, url: `${lesson.url}/slides/${slide.id}` });
      }
    } catch { contextError = true; }
  }
  const unavailableScores = scores.filter(score => score.status === 'unavailable').length;
  const candidatesTruncated = allCandidates.length > candidates.length;
  result = { status: scoresError || contextError || unavailableScores || candidatesTruncated ? 'partial' : 'complete', code, term, unitId: unit, lessons, scores, scoresError, context, contextError, coverage: { lessons: lessons.length, scoreCandidates: allCandidates.length, scoresRequested: candidates.length, unavailableScores, candidatesTruncated, contextTargets: targets.length, contextsCollected: context.length } };
}
result.capturedAt = new Date().toISOString();
result.scope = 'lesson_inventory_selected_scores_and_intro';
const path = resolve(dest); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const tmp = `${path}.${randomUUID()}.tmp`;
await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, path);
console.log(JSON.stringify({ status: result.status, lessons: result.lessons.length, scores: result.scores.length }));
