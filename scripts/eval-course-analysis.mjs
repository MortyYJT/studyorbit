#!/usr/bin/env node
// Evaluate course analysis against gold course documents (docs/eval-format.md).
// Reads already-collected data only: it never runs a collector and never writes into the desktop course folders.
// Usage: node scripts/eval-course-analysis.mjs --fixture test/fixtures/synthetic-course
//        node scripts/eval-course-analysis.mjs --run .local/lms/runs/<runId> --gold <goldDir> [--n 5]
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CourseDocumentV1Schema } from '../shared/course-data.ts';
import { buildAnalysisPrompt, courseOutputSchema } from './lib/course-analysis.mjs';
import { filterSubjects } from './lib/course-list.mjs';
import { analyseWithRepair, settleCourse, validateAnalysis } from './lib/course-validation.mjs';
import { configProblem, readLlmConfig, resolveFromStored } from './lib/llm-config.mjs';
import { analyse } from './lib/llm-providers.mjs';
import { summariseCourse, summariseOverall } from './lib/eval-score.mjs';

const VALUE_OPTIONS = new Set(['run', 'courses', 'gold', 'n', 'model', 'provider', 'fake', 'fixture', 'out']);
const GENERIC_ENV = ['COURSE_ANALYSIS_MODEL', 'COURSE_ANALYSIS_URL', 'COURSE_ANALYSIS_API_KEY'];
const PATH_OPTIONS = ['run', 'courses', 'gold', 'fake', 'fixture', 'out'];
/** Repository root: defaults (.local/...) and the model settings resolve here, whatever the working directory. */
export const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Parse CLI arguments. Needs either --fixture, or --run together with --gold. */
export function parseArgs(argv) {
  const options = { n: 5, live: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (argv[i] === '--live') { options.live = true; continue; }
    if (!argv[i].startsWith('--') || !VALUE_OPTIONS.has(name)) throw new Error(`未知参数：${argv[i]}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i - 1]} 需要一个值`);
    options[name] = value;
  }
  options.n = Number(options.n);
  if (!Number.isInteger(options.n) || options.n < 1 || options.n > 50) throw new Error('--n 必须是 1 到 50 的整数');
  if (!options.fixture && !(options.run && options.gold)) throw new Error('需要 --fixture <dir>，或同时提供 --run <runDir> 和 --gold <goldDir>');
  if (options.fixture && options.run) throw new Error('--fixture 和 --run 只能选一个');
  return options;
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

function parseGold(data, subjectCode, label) {
  const parsed = CourseDocumentV1Schema.safeParse(data);
  if (!parsed.success) throw new Error(`标准答案不符合课程 JSON v1：${label}（${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}）`);
  if (parsed.data.course.code !== subjectCode) throw new Error(`标准答案的课程代码与 ${subjectCode} 不一致：${label}`);
  return parsed.data;
}

/** Load the synthetic fixture: course.json, canvas.json, ed.json, handbook.json and gold.json in one folder. */
export async function loadFixture(dir) {
  const [course] = filterSubjects([await readJson(join(dir, 'course.json'))]);
  if (!course) throw new Error('fixture 的 course.json 缺少有效课程代码');
  const [canvas, ed, handbook, gold] = await Promise.all(['canvas', 'ed', 'handbook', 'gold'].map(name => readJson(join(dir, `${name}.json`))));
  return { course, canvas, ed, handbook, gold: parseGold(gold, course.subjectCode, 'gold.json') };
}

/**
 * Load collected data from `<runDir>/<canvasCourseId>/{canvas,ed,handbook}.json`, course metadata from courses.json
 * and gold documents from `<goldDir>/<SUBJECTCODE>.json`. Folders without metadata, data or gold are skipped.
 */
export async function loadRun({ runDir, coursesPath, goldDir }) {
  const listed = await readJson(coursesPath);
  const candidates = filterSubjects(Array.isArray(listed.courses) ? listed.courses.filter(item => item && typeof item.id === 'string') : []);
  const loaded = [], skipped = [];
  for (const entry of (await readdir(runDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const course = candidates.find(item => item.id === entry.name);
    if (!course) { skipped.push({ id: entry.name, reason: '课程列表里没有这门课或没有课程代码' }); continue; }
    const goldName = `${course.subjectCode}.json`;
    let goldText;
    try { goldText = await readFile(join(goldDir, goldName), 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`标准答案读取失败：${goldName}（${error?.code ?? error?.message ?? error}）`);
      skipped.push({ id: course.id, code: course.subjectCode, reason: '没有标准答案文件' }); continue;
    }
    let gold;
    try { gold = JSON.parse(goldText); }
    catch (error) { throw new Error(`标准答案不是有效 JSON：${goldName}（${error.message}）`); }
    let data;
    try { data = await Promise.all(['canvas', 'ed', 'handbook'].map(name => readJson(join(runDir, entry.name, `${name}.json`)))); }
    catch { skipped.push({ id: course.id, code: course.subjectCode, reason: '采集数据缺失或不可读' }); continue; }
    const [canvas, ed, handbook] = data;
    loaded.push({ course, canvas, ed, handbook, gold: parseGold(gold, course.subjectCode, `${course.subjectCode}.json`) });
  }
  return { courses: loaded, skipped };
}

/**
 * Model stand-in that replays files. For each course the k-th model call (counting every attempt of every run,
 * starting at 1) returns `<k>.json`; when that file does not exist the highest-numbered earlier file is reused.
 * Files are read from `<dir>/<canvasCourseId>/` when that folder exists, otherwise from `<dir>` itself.
 */
export function createFakeRunner(dir) {
  const calls = new Map();
  return async (_prompt, { course }) => {
    const call = (calls.get(course.id) ?? 0) + 1;
    calls.set(course.id, call);
    let folder = join(dir, course.id);
    try { if (!(await stat(folder)).isDirectory()) folder = dir; } catch { folder = dir; }
    const numbers = (await readdir(folder)).map(name => /^(\d+)\.json$/.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    if (!numbers.length) return { exitCode: 1, lastMessage: '', usage: null, error: `固定输出目录里没有 <n>.json：${folder}` };
    const pick = numbers.filter(number => number <= call).at(-1) ?? numbers[0];
    return { exitCode: 0, lastMessage: await readFile(join(folder, `${pick}.json`), 'utf8'), usage: null };
  };
}

function collectionFlags(canvas, ed, handbook) {
  return {
    canvasFailed: canvas?.status === 'unavailable', canvasUnpaginated: canvas?.paginationVerified === false,
    edFailed: ed?.status === 'unavailable', edPartial: ed?.status === 'partial', handbookFailed: handbook?.status === 'unavailable',
  };
}

/**
 * Run `n` analyses per course (sequential within a course, courses in parallel) through the same validation and
 * single repair as the real sync, then score them. `run(prompt, { course, run })` resolves to a model result.
 */
export async function evaluateCourses({ courses, n, run, isCancelled = () => false }) {
  const results = await Promise.all(courses.map(async ({ course, canvas, ed, handbook, gold }) => {
    const term = typeof course.term === 'string' ? course.term : '';
    const instructions = buildAnalysisPrompt({ course, term, canvas, ed, handbook });
    const runs = [];
    for (let index = 1; index <= n && !isCancelled(); index++) {
      const started = Date.now();
      try {
        const { result, validation, attempts } = await analyseWithRepair({
          instructions,
          run: prompt => run(prompt, { course, run: index }),
          validate: raw => validateAnalysis(raw, { course, canvas, ed, handbook }),
          isCancelled,
        });
        // Same path as the sync: the accepted output becomes a stored v2 document; no earlier document, so no legacy IDs.
        const settled = settleCourse({ result, validation, collection: collectionFlags(canvas, ed, handbook), data: { canvas, ed, handbook }, previous: null });
        // A model/process failure or a cancelled run is "failed"; only a completed but invalid answer is "rejected".
        const failed = !settled.accepted && (result.exitCode !== 0 || isCancelled());
        runs.push({ index, accepted: settled.accepted, failed, status: settled.status, reason: settled.reason, document: settled.document,
          attempts, durationMs: Date.now() - started, usage: result.usage ?? null });
      } catch (error) {
        runs.push({ index, accepted: false, failed: true, status: 'failed', reason: String(error?.message ?? error).slice(0, 300), document: null,
          attempts: [], durationMs: Date.now() - started, usage: null });
      }
    }
    return { id: course.id, code: course.subjectCode, runs, summary: summariseCourse(gold, runs) };
  }));
  return { courses: results, overall: summariseOverall(results.map(result => result.summary)) };
}

/** Saved settings > environment > defaults, then the optional --provider / --model overrides. */
export async function resolveEvalConfig(projectDir, env, { provider, model } = {}) {
  const stored = await readLlmConfig(projectDir);
  let config = resolveFromStored(stored, env);
  if (provider && provider !== config.provider) {
    // Never reuse a key saved for another vendor: drop saved settings, and the generic variables unless they name this provider.
    const scoped = { ...env, COURSE_ANALYSIS_PROVIDER: provider };
    if (env.COURSE_ANALYSIS_PROVIDER !== provider) for (const key of GENERIC_ENV) delete scoped[key];
    config = resolveFromStored(null, scoped);
  }
  return model ? { ...config, model } : config;
}

const pct = value => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

/** Short Markdown report printed to the console and saved as summary.md. */
export function formatSummary(summary) {
  const lines = [
    `# 课程分析评测 ${summary.startedAt}`, '',
    `模式：${summary.mode === 'fake' ? '固定输出' : `模型 ${summary.provider} / ${summary.model ?? '默认'}`}；每门课 ${summary.n} 次。`, '',
    '| 课程 | 运行 | 有结果 | 触发修复 | 最终拒绝 | 调用失败 | 字段准确率 | 召回 | 精确 | 单元格一致 | 与首次相同 | 无出处（权重/规则） | 输入/输出 token | 平均耗时 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const row = (label, s) => `| ${label} | ${s.runs} | ${s.documentRuns} | ${s.interception.repairTriggered} | ${s.interception.rejected} | ${s.interception.failed} | ${pct(s.fieldAccuracy)} | ${pct(s.recall)} | ${pct(s.precision)} | ${pct(s.cellAgreement)} | ${pct(s.identicalToFirst)} | ${s.unsourced.weight}/${s.unsourced.rule} | ${s.tokens.runsWithUsage ? `${s.tokens.input}/${s.tokens.output}` : '—'} | ${s.durationMs.mean === null ? '—' : `${(s.durationMs.mean / 1000).toFixed(1)}s`} |`;
  for (const course of summary.courses) lines.push(row(course.code, course.summary));
  if (summary.courses.length > 1) lines.push(row('合计', summary.overall));
  lines.push('', `各字段准确率：${Object.entries(summary.overall.perField).map(([field, value]) => `${field} ${pct(value)}`).join('，')}`);
  const issues = Object.entries(summary.overall.interception.issues).sort((a, b) => b[1] - a[1]);
  lines.push('', issues.length ? `校验问题：\n${issues.map(([issue, count]) => `- ${count} × ${issue}`).join('\n')}` : '校验问题：无');
  if (summary.skipped.length) lines.push('', `跳过：\n${summary.skipped.map(item => `- ${item.code ?? item.id}：${item.reason}`).join('\n')}`);
  return `${lines.join('\n')}\n`;
}

// Real path of `path`: resolve symlinks on the nearest existing ancestor and keep the rest as written.
async function canonicalPath(path) {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try { return join(await realpath(current), ...rest.reverse()); }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** True when `path` is `dir` or inside it, after resolving symlinks; case-insensitive on macOS and Windows. */
export async function isInside(path, dir) {
  const fold = ['darwin', 'win32'].includes(process.platform) ? value => value.toLowerCase() : value => value;
  const rel = relative(fold(await canonicalPath(dir)), fold(await canonicalPath(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Load inputs, run the evaluation and save every run plus summary.json / summary.md under the out directory. */
export async function runEvaluation(options, { projectDir, env = process.env, log = console.log, isCancelled } = {}) {
  const startedAt = new Date().toISOString();
  const outDir = resolve(projectDir, options.out ?? join('.local', 'eval', 'results', startedAt.replace(/[:.]/g, '-')));
  if (await isInside(outDir, join(homedir(), 'Desktop'))) throw new Error('OUT_DIR_NOT_ALLOWED：结果不能写到桌面，避免和课程文件夹混在一起');
  const fakeDir = options.fake ?? (options.fixture && !options.live ? join(options.fixture, 'outputs') : null);
  const { courses, skipped } = options.fixture
    ? { courses: [await loadFixture(resolve(projectDir, options.fixture))], skipped: [] }
    : await loadRun({ runDir: resolve(projectDir, options.run), coursesPath: resolve(projectDir, options.courses ?? join('.local', 'lms', 'courses.json')), goldDir: resolve(projectDir, options.gold) });
  if (!courses.length) throw new Error('没有可评测的课程（需要采集数据、课程列表和标准答案三者齐全）');

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  let run, config = null;
  if (fakeDir) run = createFakeRunner(resolve(projectDir, fakeDir));
  else {
    config = await resolveEvalConfig(projectDir, env, options);
    const problem = configProblem(config);
    if (problem) throw new Error(problem);
    const schema = courseOutputSchema();
    const schemaPath = join(outDir, 'course-output.schema.json');
    await writeFile(schemaPath, JSON.stringify(schema, null, 2), { mode: 0o600 });
    run = prompt => analyse(config, prompt, { schema, schemaPath, cwd: projectDir, registerStop: () => () => {} });
  }

  const evaluation = await evaluateCourses({ courses, n: options.n, run, isCancelled });
  for (const course of evaluation.courses) {
    const dir = join(outDir, course.code);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const record of course.runs) await writeFile(join(dir, `run-${record.index}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }
  const summary = {
    startedAt, finishedAt: new Date().toISOString(), n: options.n, mode: fakeDir ? 'fake' : 'model',
    provider: config?.provider ?? null, model: config?.model ?? null,
    courses: evaluation.courses.map(({ id, code, summary: courseSummary }) => ({ id, code, summary: courseSummary })),
    overall: evaluation.overall, skipped,
  };
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  const markdown = formatSummary(summary);
  await writeFile(join(outDir, 'summary.md'), markdown, { mode: 0o600 });
  log(markdown);
  log(`结果已保存到 ${relative(projectDir, outDir) || '.'}`);
  return { outDir, summary, evaluation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let cancelled = false;
  process.on('SIGINT', () => { if (cancelled) process.exit(130); cancelled = true; console.error('正在停止：当前调用结束后不再开始新的运行。再按一次立即退出。'); });
  try {
    // Paths given on the command line are relative to the working directory; defaults are relative to the repository.
    const options = parseArgs(process.argv.slice(2));
    for (const key of PATH_OPTIONS) if (options[key]) options[key] = resolve(process.cwd(), options[key]);
    await runEvaluation(options, { projectDir: PROJECT_DIR, isCancelled: () => cancelled });
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
