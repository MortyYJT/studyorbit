#!/usr/bin/env node
// Chat Q&A evaluation (docs/eval-chat-qa.md, decision #329): ask every synthetic question as a fresh one-message chat,
// N times per mode, in context mode (prompt and course context used before tool calling) and tool mode, through the
// same runChatReply the chat route uses, then grade each answer deterministically.
// Usage: node scripts/eval-chat-qa.mjs [--mode context|tools|both] [--n 5] [--only id,id] [--provider p] [--model m]
//        [--concurrency 4] [--out dir] [--fixtures dir] [--fake dir]
//        node scripts/eval-chat-qa.mjs --rescore <resultsDir> [--out dir]   (regrade saved answers, no model calls)
// Only the synthetic fixtures are sent to a model; nothing reads synced course data or the Desktop.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CourseDocumentSchema, toDisplayDocument } from '../shared/course-data.ts';
import { parsePlanningSnapshot } from '../shared/planning-snapshot.ts';
import { isInside, resolveEvalConfig } from './eval-course-analysis.mjs';
import { runChatReply } from './lib/chat-reply.mjs';
import { configProblem } from './lib/llm-config.mjs';
import { gradeAnswer } from './lib/qa-grade.mjs';

export const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_FIXTURES = join('test', 'fixtures', 'qa');
const MODES = ['context', 'tools'];
const VALUE_OPTIONS = new Set(['mode', 'n', 'only', 'provider', 'model', 'fake', 'out', 'fixtures', 'concurrency', 'rescore']);
const PATH_OPTIONS = ['fake', 'out', 'fixtures', 'rescore'];
/** Questions whose answers must come from a grade calculation. */
const CALCULATION_CATEGORIES = ['grade', 'final'];
const CALCULATION_TOOLS = ['calculate_grades', 'final_needed'];
const FAKE_CONFIG = Object.freeze({ provider: 'deepseek', model: 'fake-model', baseUrl: null, apiKey: 'fake-key' });

/**
 * Parse CLI arguments: mode both, N 5 (1–20), concurrency 4 (1–8); --fake excludes --provider and --model;
 * --rescore takes only --out and --fixtures.
 */
export function parseArgs(argv) {
  const options = { mode: 'both', n: 5, concurrency: 4 };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !VALUE_OPTIONS.has(name)) throw new Error(`未知参数：${argv[i]}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[i - 1]} 需要一个值`);
    options[name] = value;
    given.add(name);
  }
  if (options.rescore) {
    const extra = [...given].filter(name => !['rescore', 'out', 'fixtures'].includes(name));
    if (extra.length) throw new Error(`--rescore 只重新评分已保存的回答，不能和 ${extra.map(name => `--${name}`).join('、')} 一起用`);
  }
  if (!['both', ...MODES].includes(options.mode)) throw new Error('--mode 只能是 context、tools 或 both');
  options.n = Number(options.n);
  if (!Number.isInteger(options.n) || options.n < 1 || options.n > 20) throw new Error('--n 必须是 1 到 20 的整数');
  options.concurrency = Number(options.concurrency);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('--concurrency 必须是 1 到 8 的整数');
  if (typeof options.only === 'string') options.only = options.only.split(',').map(id => id.trim()).filter(Boolean);
  if (options.fake && (options.provider || options.model)) throw new Error('--fake 使用固定输出，不能和 --provider、--model 一起用');
  return options;
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

/**
 * Load `context.json` (today, courses, scope, document and planning file names), the course documents, the planning
 * snapshot and `questions.json` from a fixture folder. Documents and the snapshot are validated like synced data.
 */
export async function loadQaFixtures(dir) {
  const context = await readJson(join(dir, 'context.json'));
  const documents = await Promise.all(context.documents.map(async name => {
    const parsed = CourseDocumentSchema.safeParse(await readJson(join(dir, name)));
    if (!parsed.success) throw new Error(`题集课程文件不合法：${name}（${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}）`);
    return parsed.data;
  }));
  const planning = parsePlanningSnapshot(context.planning ? await readJson(join(dir, context.planning)) : null);
  if (!planning.ok) throw new Error('题集计划快照不合法');
  const { questions } = await readJson(join(dir, 'questions.json'));
  return { today: context.today, courses: context.courses, scope: context.scope, documents, planning: planning.planning, questions };
}

/** The registry context the chat builds for one question: display documents, its scope, the date and the snapshot. */
export function toolContextFor(fixtures, question) {
  return { documents: fixtures.documents.map(toDisplayDocument), courses: fixtures.courses, scope: question.scope ?? fixtures.scope, today: fixtures.today, planning: fixtures.planning };
}

// ---- Scripted provider streams (--fake) -----------------------------------------------------------------------
// `<dir>/<questionId>.json` holds `{ context, tools }`: a list of steps, or a list of step lists picked by run number.
// A step is `{ text?, calls?: [{ name, args }], usage?: { input, output }, status? }`; each model request takes the
// next step (the last one repeats). Steps become DeepSeek Responses event streams; a missing script is HTTP 500.

const conversation = new AsyncLocalStorage();

function sse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function fakeResponse(step, index) {
  if (!step) return new Response(JSON.stringify({ error: { message: 'no scripted response for this question and mode' } }), { status: 500 });
  if (step.status) return new Response(JSON.stringify({ error: { message: 'scripted failure' } }), { status: step.status });
  return sse([
    ...(step.text ? [{ type: 'response.output_text.delta', delta: step.text }] : []),
    ...(step.calls ?? []).map((call, position) => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call_${index}_${position}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) } })),
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: step.usage?.input ?? 100, output_tokens: step.usage?.output ?? 10 } } },
  ]);
}

/** A fetch stand-in that answers from the scripts of the conversation it is called in and never touches the network. */
function createFakeFetch(dir) {
  const scripts = new Map();
  const load = id => {
    if (!scripts.has(id)) scripts.set(id, readJson(join(dir, `${id}.json`)).catch(error => { if (error?.code === 'ENOENT') return null; throw error; }));
    return scripts.get(id);
  };
  return async () => {
    const state = conversation.getStore();
    if (!state) throw new Error('--fake 模式下不允许网络请求');
    const script = await load(state.id);
    const entry = script?.[state.mode];
    const steps = Array.isArray(entry?.[0]) ? entry[(state.run - 1) % entry.length] : entry;
    const index = state.requests++;
    return fakeResponse(Array.isArray(steps) && steps.length ? steps[Math.min(index, steps.length - 1)] : null, index);
  };
}

// ---- Summary --------------------------------------------------------------------------------------------------

const ratio = (passed, answers) => (answers ? passed / answers : null);

/** Per-mode metrics: accuracy overall, by category and per question; tool use; fallbacks; failures; tokens; time. */
export function summariseQa(records, questions) {
  const category = new Map(questions.map(question => [question.id, question.category]));
  const order = new Map(questions.map((question, index) => [question.id, index]));
  const result = {};
  for (const mode of MODES) {
    // Question order, then run: categories and questions are listed in the order of the question set.
    const own = records.filter(record => record.mode === mode).sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.run - b.run);
    if (!own.length) continue;
    const byCategory = {}, perQuestion = {}, byTool = {};
    for (const record of own) {
      const pass = record.grade.pass ? 1 : 0;
      const group = (byCategory[category.get(record.id)] ??= { answers: 0, passed: 0, accuracy: null });
      group.answers += 1; group.passed += pass;
      const entry = (perQuestion[record.id] ??= { answers: 0, passed: 0, rate: null });
      entry.answers += 1; entry.passed += pass;
      for (const step of record.steps ?? []) byTool[step.name] = (byTool[step.name] ?? 0) + 1;
    }
    for (const group of Object.values(byCategory)) group.accuracy = ratio(group.passed, group.answers);
    for (const entry of Object.values(perQuestion)) entry.rate = ratio(entry.passed, entry.answers);
    const calculation = own.filter(record => CALCULATION_CATEGORIES.includes(category.get(record.id)));
    const usage = own.map(record => record.usage).filter(Boolean);
    const durations = own.map(record => record.durationMs);
    const passed = own.filter(record => record.grade.pass).length;
    result[mode] = {
      answers: own.length, passed, accuracy: ratio(passed, own.length),
      failedCalls: own.filter(record => record.grade.failedCall).length,
      fallbacks: own.filter(record => record.fallback).length,
      byCategory, perQuestion,
      toolUse: {
        answersWithStep: own.filter(record => record.steps?.length).length,
        toolCalls: own.reduce((sum, record) => sum + (record.steps?.length ?? 0), 0),
        calculationAnswers: calculation.length,
        calculationAnswersWithTool: calculation.filter(record => (record.steps ?? []).some(step => CALCULATION_TOOLS.includes(step.name))).length,
        byTool,
      },
      tokens: {
        input: usage.reduce((sum, entry) => sum + entry.input, 0), cached: usage.reduce((sum, entry) => sum + (entry.cached ?? 0), 0),
        output: usage.reduce((sum, entry) => sum + entry.output, 0), reasoning: usage.reduce((sum, entry) => sum + (entry.reasoning ?? 0), 0),
        answersWithUsage: usage.length,
      },
      durationMs: { total: durations.reduce((sum, ms) => sum + ms, 0), mean: Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length), max: Math.max(...durations) },
    };
  }
  return result;
}

const pct = (passed, answers) => (answers ? `${(passed / answers * 100).toFixed(1)}%（${passed}/${answers}）` : '—');

/** Markdown report printed to the console and saved as summary.md: the two modes side by side. */
export function formatQaSummary(summary) {
  const modes = MODES.filter(mode => summary.modes[mode]);
  const label = { context: '上下文模式（改造前）', tools: '工具模式（改造后）' };
  const lines = [
    `# 对话问答评测 ${summary.startedAt}`, '',
    `服务商 / 模型：${summary.provider} / ${summary.model ?? '默认'}；${summary.questions} 道题，每种模式每题 ${summary.n} 次。${summary.mode === 'rescore' ? '用当前题集重新评分已保存的回答，没有调用模型。' : ''}`, '',
    `| 类别 | ${modes.map(mode => label[mode]).join(' | ')} |`, `| --- |${modes.map(() => ' ---: |').join('')}`,
  ];
  const categories = [...new Set(modes.flatMap(mode => Object.keys(summary.modes[mode].byCategory)))];
  for (const category of categories) lines.push(`| ${category} | ${modes.map(mode => { const group = summary.modes[mode].byCategory[category]; return group ? pct(group.passed, group.answers) : '—'; }).join(' | ')} |`);
  lines.push(`| 总体 | ${modes.map(mode => pct(summary.modes[mode].passed, summary.modes[mode].answers)).join(' | ')} |`, '');
  for (const mode of modes) {
    const s = summary.modes[mode];
    lines.push(`- ${label[mode]}：调用失败 ${s.failedCalls}，回退 ${s.fallbacks}；用了工具的回答 ${s.toolUse.answersWithStep}，工具调用 ${s.toolUse.toolCalls} 次，成绩/期末题调用了计算工具 ${s.toolUse.calculationAnswersWithTool}/${s.toolUse.calculationAnswers}；`
      + `token 输入 ${s.tokens.input}（缓存 ${s.tokens.cached}）、输出 ${s.tokens.output}（推理 ${s.tokens.reasoning}）；平均 ${(s.durationMs.mean / 1000).toFixed(1)} 秒，最长 ${(s.durationMs.max / 1000).toFixed(1)} 秒。`);
  }
  const ids = [...new Set(modes.flatMap(mode => Object.keys(summary.modes[mode].perQuestion)))];
  lines.push('', `| 题目 | ${modes.map(mode => label[mode]).join(' | ')} |`, `| --- |${modes.map(() => ' ---: |').join('')}`);
  for (const id of ids) lines.push(`| ${id} | ${modes.map(mode => { const entry = summary.modes[mode].perQuestion[id]; return entry ? `${entry.passed}/${entry.answers}` : '—'; }).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

// ---- Run ------------------------------------------------------------------------------------------------------

/**
 * Run tasks with at most `size` at a time. After the first failure no new task starts, and the promise rejects with
 * that failure only once every running task has finished, so callers never clean up (or restore `fetch`) under them.
 */
export async function runPool(tasks, size, isCancelled) {
  let next = 0, failure = null;
  const worker = async () => {
    while (next < tasks.length && !failure && !isCancelled()) {
      const task = tasks[next++];
      try { await task(); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  if (failure) throw failure.error;
}

async function writeSummary(outDir, summary, projectDir, log) {
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  const markdown = formatQaSummary(summary);
  await writeFile(join(outDir, 'summary.md'), markdown, { mode: 0o600 });
  log(markdown);
  log(`结果已保存到 ${relative(projectDir, outDir) || '.'}`);
}

/**
 * Regrade the saved answers in `<resultsDir>/<mode>/<id>/run-<i>.json` with the current gold data and write only a
 * new summary.json / summary.md; no model calls. Answers to questions no longer in the set are left out.
 */
async function rescoreQa({ resultsDir, outDir, fixtures, startedAt, projectDir, log }) {
  if (await isInside(outDir, resultsDir)) throw new Error('OUT_DIR_NOT_ALLOWED：重新评分的结果不能写进原结果目录，避免覆盖原来的汇总');
  let saved = null;
  try { saved = await readJson(join(resultsDir, 'summary.json')); } catch { saved = null; }
  const byId = new Map(fixtures.questions.map(question => [question.id, question]));
  const records = [], skipped = new Set();
  for (const mode of MODES) {
    let ids;
    try { ids = (await readdir(join(resultsDir, mode), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    for (const id of ids) {
      const question = byId.get(id);
      if (!question) { skipped.add(id); continue; }
      const files = (await readdir(join(resultsDir, mode, id))).filter(name => /^run-\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)));
      for (const name of files) {
        const record = await readJson(join(resultsDir, mode, id, name));
        records.push({ ...record, grade: gradeAnswer({ ok: record.ok, text: record.text ?? '', ...(record.stopped ? { stopped: true } : {}), ...(record.error ? { error: record.error } : {}) }, question.gold) });
      }
    }
  }
  if (!records.length) throw new Error('没有可重新评分的回答（需要 <模式>/<题目 ID>/run-<i>.json）');
  if (skipped.size) log(`跳过题集里已没有的题目：${[...skipped].join(', ')}`);
  const questions = fixtures.questions.filter(question => records.some(record => record.id === question.id));
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const summary = {
    startedAt, finishedAt: new Date().toISOString(), mode: 'rescore', source: resultsDir, originalStartedAt: saved?.startedAt ?? null,
    provider: saved?.provider ?? null, model: saved?.model ?? null, n: saved?.n ?? Math.max(...records.map(record => record.run)),
    questions: questions.length, modes: summariseQa(records, questions),
  };
  await writeSummary(outDir, summary, projectDir, log);
  return { outDir, summary, records };
}

/** Load the fixtures, run every question N times per mode, and save each answer plus summary.json / summary.md. */
export async function runQaEvaluation(options, { projectDir = PROJECT_DIR, env = process.env, log = console.log, isCancelled = () => false } = {}) {
  const startedAt = new Date().toISOString();
  const outDir = resolve(projectDir, options.out ?? join('.local', 'eval', 'qa', startedAt.replace(/[:.]/g, '-')));
  if (await isInside(outDir, join(homedir(), 'Desktop'))) throw new Error('OUT_DIR_NOT_ALLOWED：结果不能写到桌面，避免和课程文件夹混在一起');
  const fixtures = await loadQaFixtures(resolve(projectDir, options.fixtures ?? DEFAULT_FIXTURES));
  if (options.rescore) return rescoreQa({ resultsDir: resolve(projectDir, options.rescore), outDir, fixtures, startedAt, projectDir, log });
  const unknown = (options.only ?? []).filter(id => !fixtures.questions.some(question => question.id === id));
  if (unknown.length) throw new Error(`没有这些题目：${unknown.join(', ')}`);
  const questions = options.only ? fixtures.questions.filter(question => options.only.includes(question.id)) : fixtures.questions;
  const modes = options.mode === 'both' ? MODES : [options.mode];

  let config = FAKE_CONFIG;
  if (!options.fake) {
    config = await resolveEvalConfig(projectDir, env, options);
    const problem = configProblem(config);
    if (problem) throw new Error(problem);
    if (modes.includes('tools') && config.provider === 'codex') throw new Error('codex 没有工具模式，只能用 --mode context');
  }
  const provider = options.fake ? 'fake' : config.provider;
  log(`计划：${questions.length} 道题 × N ${options.n} × ${modes.length} 种模式 = ${questions.length * options.n * modes.length} 次对话（${provider} / ${config.model ?? '默认'}，并发 ${options.concurrency}）`);

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const fakeFetch = options.fake ? createFakeFetch(resolve(projectDir, options.fake)) : null;
  const realFetch = globalThis.fetch;
  if (fakeFetch) globalThis.fetch = fakeFetch;
  const records = [];
  try {
    const tasks = modes.flatMap(mode => questions.flatMap(question => Array.from({ length: options.n }, (_, index) => async () => {
      const run = index + 1;
      const begun = Date.now();
      const state = { id: question.id, mode, run, requests: 0 };
      let reply;
      try {
        reply = await conversation.run(state, () => runChatReply({
          config, mode, messages: [{ role: 'user', content: question.question, at: startedAt }],
          documents: fixtures.documents, courses: fixtures.courses, scope: question.scope ?? fixtures.scope,
          today: fixtures.today, language: question.language, planning: fixtures.planning,
        }, { cwd: projectDir }));
      } catch (error) {
        reply = { ok: false, error: String(error?.message ?? error).slice(0, 300), usage: null, model: config.model, message: null };
      }
      const message = reply.message;
      const answer = { ok: reply.ok, text: message?.content ?? '', ...(reply.stopped ? { stopped: true } : {}), ...(reply.error ? { error: reply.error } : {}) };
      const record = {
        id: question.id, mode, run, category: question.category, language: question.language, question: question.question,
        ...answer, steps: message?.steps ?? [], usage: reply.usage ?? null, model: reply.model ?? null, fallback: Boolean(message?.fallback),
        durationMs: Date.now() - begun, grade: gradeAnswer(answer, question.gold),
      };
      const dir = join(outDir, mode, question.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, `run-${run}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      records.push(record);
      log(`${mode} ${question.id} #${run}: ${record.grade.pass ? '通过' : record.grade.failedCall ? `调用失败（${answer.stopped ? '已停止' : answer.error}）` : '未通过'}`);
    })));
    await runPool(tasks, options.concurrency, isCancelled);
  } finally {
    if (fakeFetch) globalThis.fetch = realFetch;
  }

  const summary = {
    startedAt, finishedAt: new Date().toISOString(), provider, model: config.model, n: options.n, mode: options.mode,
    questions: questions.length, only: options.only ?? null, cancelled: isCancelled() || undefined,
    modes: summariseQa(records, questions),
  };
  await writeSummary(outDir, summary, projectDir, log);
  return { outDir, summary, records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let cancelled = false;
  process.on('SIGINT', () => { if (cancelled) process.exit(130); cancelled = true; console.error('正在停止：进行中的对话结束后不再开始新的。再按一次立即退出。'); });
  try {
    const options = parseArgs(process.argv.slice(2));
    for (const key of PATH_OPTIONS) if (options[key]) options[key] = resolve(process.cwd(), options[key]);
    await runQaEvaluation(options, { isCancelled: () => cancelled });
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
