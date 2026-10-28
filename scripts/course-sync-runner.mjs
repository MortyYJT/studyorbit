import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { filterSubjects } from './lib/course-list.mjs';
import { CourseDocumentSchema } from '../shared/course-data.ts';
import { courseOutputSchema, buildAnalysisPrompt } from './lib/course-analysis.mjs';

const codePattern = /^[A-Z]{4}[1-9]\d{4}$/;
const counts = usage => {
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return null;
  const cached = usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.reasoning_output_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens;
  return { input, cached: Number.isSafeInteger(cached) ? cached : null, output, reasoning: Number.isSafeInteger(reasoning) ? reasoning : null };
};

async function childUsage(parentId, start) {
  if (!parentId) return null;
  const dates = new Set([start, new Date()].map(date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('/')));
  const records = [];
  for (const day of dates) {
    const dir = join(homedir(), '.codex', 'sessions', day);
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter(name => name.endsWith('.jsonl'))) {
      const file = join(dir, name);
      let stream;
      try {
        stream = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        let first = true, matched = false, latest = null;
        for await (const line of stream) {
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (first) {
            first = false;
            matched = event?.payload?.source?.subagent?.thread_spawn?.parent_thread_id === parentId;
            if (!matched) break;
          }
          if (event?.payload?.type === 'token_count') latest = counts(event.payload.info?.total_token_usage) ?? latest;
        }
        if (matched && latest) records.push(latest);
      } catch { /* A missing or inaccessible log is recorded as unavailable. */ }
      finally { stream?.close(); }
    }
  }
  if (!records.length) return null;
  return records.reduce((a, b) => ({ input: a.input + b.input, cached: a.cached === null || b.cached === null ? null : a.cached + b.cached,
    output: a.output + b.output, reasoning: a.reasoning === null || b.reasoning === null ? null : a.reasoning + b.reasoning }),
    { input: 0, cached: 0, output: 0, reasoning: 0 });
}

// Run a cancellable local collection task without logging source data or credentials.
function runCollector(script, args, cwd, registerStop) {
  return new Promise(resolveTask => {
    const proc = spawn(process.execPath, [join(cwd, 'scripts', script), ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    let stderr = '', done = false, escalation;
    proc.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString().slice(0, 4000 - stderr.length); });
    const stop = () => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' }); else if (proc.pid) process.kill(-proc.pid, 'SIGTERM'); } catch {} if (!escalation) escalation = setTimeout(() => { try { if (proc.pid && process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL'); } catch {} }, 5000); };
    const untrack = registerStop(stop);
    const timer = setTimeout(stop, 120000);
    const finish = code => { if (done) return; done = true; clearTimeout(timer); untrack(); resolveTask({ code, error: stderr.trim().slice(0, 500) }); };
    proc.on('error', () => finish(null)); proc.on('close', finish);
  });
}

export function createCourseSyncRunner(projectDir) {
  let active = false;
  let cancelled = false;
  const activeStops = new Set();
  const trackStop = stop => { activeStops.add(stop); if (cancelled) stop(); return () => activeStops.delete(stop); };
  let state = { running: false, courses: [], error: null };
  const usagePath = join(projectDir, '.local', 'lms', 'course-sync-usage.jsonl');
  const schemaPath = join(projectDir, '.local', 'lms', 'course-output.schema.json');

  async function start(ids) {
    if (active) throw new Error('SYNC_RUNNING');
    active = true;
    cancelled = false;
    try {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('INVALID_SELECTION');
      const input = JSON.parse(await readFile(join(projectDir, '.local', 'lms', 'courses.json'), 'utf8'));
      if (!Array.isArray(input.courses)) throw new Error('COURSES_UNAVAILABLE');
      const candidates = filterSubjects(input.courses.filter(item => item && typeof item.id === 'string'));
      const selected = ids.map(id => candidates.find(item => item.id === id));
      if (selected.some(item => !item || !codePattern.test(item.subjectCode))) throw new Error('INVALID_SELECTION');
      await mkdir(dirname(schemaPath), { recursive: true });
      await writeFile(schemaPath, JSON.stringify(courseOutputSchema(), null, 2), { mode: 0o600 });
      const runId = randomUUID().slice(0, 8);
      state = { running: true, courses: selected.map(course => ({ id: course.id, code: course.subjectCode, status: 'pending', reason: '' })), error: null };
      void runSequential(selected, runId).catch(() => {
        state.error = '同步任务异常中断，请检查本地环境。';
        for (const course of state.courses) if (course.status === 'pending' || course.status === 'running') course.status = 'failed';
      }).finally(() => { state.running = false; active = false; });
      return state;
    } catch (error) { active = false; throw error; }
  }

  async function runSequential(courses, runId) {
    const analyses = [];
    for (let index = 0; index < courses.length; index++) {
      const course = courses[index], row = state.courses[index];
      if (cancelled) { row.status = 'cancelled'; continue; }
      row.status = 'running';
      row.phase = 'starting';
      const start = new Date();
      const phaseDurations = {};
      try {
        const term = typeof course.term === 'string' ? course.term : '';
        const match = /(20\d{2}).*?(?:semester|sem)\s*([12])/i.exec(term);
        const label = match ? `${match[1]} S${match[2]}` : term.replace(/[^\w\u4e00-\u9fff -]/g, '').trim().slice(0, 50) || '未知学期';
        const courseDir = join(homedir(), 'Desktop', `墨尔本大学 ${label}`, course.subjectCode);
        await mkdir(courseDir, { recursive: true });
        let outputPath = join(courseDir, '分数结构.json');
        try { await stat(outputPath); outputPath = join(courseDir, `分数结构-${runId}.json`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const runDir = join(projectDir, '.local', 'lms', 'runs', runId, course.id);
        await mkdir(runDir, { recursive: true, mode: 0o700 });
        const canvasPath = join(runDir, 'canvas.json'), edPath = join(runDir, 'ed.json'), handbookPath = join(runDir, 'handbook.json');
        const registerStop = trackStop;
        row.phase = 'canvas';
        let phaseStart = Date.now();
        const canvas = await runCollector('canvas-background.mjs', [course.id, canvasPath], projectDir, registerStop);
        phaseDurations.canvasMs = Date.now() - phaseStart;
        if (cancelled) { row.status = 'cancelled'; continue; }
        if (canvas.code !== 0) await writeFile(canvasPath, JSON.stringify({ status: 'unavailable', reason: 'Canvas 采集不可用' }), { mode: 0o600 });
        row.phase = 'ed'; phaseStart = Date.now();
        const ed = await runCollector('collect-ed-course.mjs', [course.subjectCode, term, edPath], projectDir, registerStop);
        phaseDurations.edMs = Date.now() - phaseStart;
        if (cancelled) { row.status = 'cancelled'; continue; }
        if (ed.code !== 0) await writeFile(edPath, JSON.stringify({ status: 'unavailable', lessons: [], scores: [], reason: 'Ed 采集不可用' }), { mode: 0o600 });
        row.phase = 'handbook'; phaseStart = Date.now();
        const year = /\b(20\d{2})\b/.exec(term)?.[1];
        const handbook = year ? await runCollector('collect-handbook.mjs', [course.subjectCode, year, handbookPath], projectDir, registerStop) : { code: null, error: '学年未知' };
        phaseDurations.handbookMs = Date.now() - phaseStart;
        if (cancelled) { row.status = 'cancelled'; continue; }
        if (handbook.code !== 0) await writeFile(handbookPath, JSON.stringify({ status: 'unavailable', reason: 'Handbook 采集不可用' }), { mode: 0o600 });
        row.phase = 'waiting_analysis';
        analyses.push((async () => {
          if (cancelled) { row.status = 'cancelled'; return; }
          row.phase = 'analysis'; const analysisStarted = Date.now();
          try {
        const canvasData = JSON.parse(await readFile(canvasPath, 'utf8'));
        const instructions = buildAnalysisPrompt({ course, term,
          canvas: canvasData,
          ed: JSON.parse(await readFile(edPath, 'utf8')),
          handbook: JSON.parse(await readFile(handbookPath, 'utf8')),
        });
        if (cancelled) { row.status = 'cancelled'; return; }
        const provider = process.env.COURSE_ANALYSIS_PROVIDER || 'codex';
        let result, report, parsed;
        const attempts = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const repair = attempt ? `\n上次输出未通过校验，请只修复并完整返回符合 Schema 的 JSON。错误：${JSON.stringify(result.issues)}\n上次输出：${result.lastMessage}` : '';
          result = provider === 'deepseek'
            ? await runDeepSeek(instructions + repair, trackStop)
            : provider === 'openai-compatible'
            ? await runCompatible(instructions + repair, trackStop)
            : provider === 'codex' ? await runCodex(instructions + repair, courseDir, schemaPath, projectDir, trackStop, () => { row.phase = 'analysis'; })
              : { exitCode: 1, lastMessage: '', usage: null, error: `未知分析提供方：${provider}` };
          try { report = JSON.parse(result.lastMessage); } catch { report = null; }
          parsed = CourseDocumentSchema.safeParse(report?.document);
          result.issues = parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
          if (parsed.success) {
            const items = parsed.data.assessments;
            for (const [index, item] of items.entries()) {
              const children = items.filter(child => child.parentId === item.id && child.nature === 'regular');
              if (item.scoring !== 'none' && (item.parentId !== null || children.length === 0)) result.issues.push(`assessments.${index}.scoring: 只有有计分子项的顶层父项可使用 points 或 weighted`);
              if (item.scoring === 'weighted' && children.some(child => child.weight === null || child.weight <= 0)) result.issues.push(`assessments.${index}.scoring: weighted 要求每个计分子项有明确正权重`);
            }
          }
          const validReport = report && typeof report.reason === 'string' && ['completed', 'partial', 'failed'].includes(report.status) && (report.status === 'failed' ? report.document === null : parsed.success && result.issues.length === 0 && parsed.data.course.id === course.id && parsed.data.course.code === course.subjectCode);
          if (!validReport && !result.issues.length) result.issues = ['结果格式或课程身份不匹配'];
          attempts.push({ exitCode: result.exitCode, raw: result.lastMessage, issues: result.issues, usage: result.usage });
          if (result.exitCode !== 0 || cancelled || validReport) break;
        }
        if (attempts.length > 1) {
          const diagnosticDir = join(projectDir, '.local', 'lms', 'sync-errors');
          await mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
          await writeFile(join(diagnosticDir, `${runId}-${course.id}-attempts.json`), JSON.stringify(attempts, null, 2), { mode: 0o600 });
          if (attempts.every(item => item.usage)) result.usage = Object.fromEntries(['input', 'cached', 'output', 'reasoning'].map(key => [key, attempts.every(item => Number.isSafeInteger(item.usage[key])) ? attempts.reduce((sum, item) => sum + item.usage[key], 0) : null]));
          else result.usage = null;
        }
        phaseDurations.analysisMs = Date.now() - analysisStarted;
        if (cancelled) {
          row.status = 'cancelled';
          const child = await childUsage(result.threadId, start);
          await mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
          await appendFile(usagePath, `${JSON.stringify({ at: start.toISOString(), course: course.subjectCode, model: process.env.COURSE_ANALYSIS_MODEL || (process.env.COURSE_ANALYSIS_PROVIDER === 'deepseek' ? 'deepseek-flash' : 'gpt-6-luna'), durationMs: Date.now() - start.getTime(), status: 'cancelled', phases: phaseDurations, coordinator: result.usage, subagents: child })}\n`, { mode: 0o600 });
          return;
        }
        row.phase = 'saving';
        const child = await childUsage(result.threadId, start);
        if (cancelled) { row.status = 'cancelled'; return; }
        const allowed = ['completed', 'partial', 'failed'];
        const validCourse = parsed.success && result.issues.length === 0 && parsed.data.course.id === course.id && parsed.data.course.code === course.subjectCode;
        if (result.exitCode === 0 && report && typeof report.reason === 'string' && allowed.includes(report.status) && (report.status === 'failed' ? report.document === null : validCourse)) {
          row.status = report.status;
          row.reason = typeof report.reason === 'string' ? report.reason.slice(0, 500) : '';
          if (canvas.code !== 0 || canvasData.paginationVerified === false || ed.code !== 0 || handbook.code !== 0) { if (row.status === 'completed') row.status = 'partial'; row.reason = `${canvas.code !== 0 ? 'Canvas 数据未能读取；' : canvasData.paginationVerified === false ? 'Canvas 仅采集第一页；' : ''}${ed.code !== 0 ? 'Ed 数据未能读取；' : ''}${handbook.code !== 0 ? 'Handbook 数据未能读取；' : ''}${row.reason}`; }
          if (report.status === 'failed') {
            const diagnosticDir = join(projectDir, '.local', 'lms', 'sync-errors');
            await mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
            await writeFile(join(diagnosticDir, `${runId}-${course.id}.json`), JSON.stringify({ raw: result.lastMessage, issues: [] }, null, 2), { mode: 0o600 });
          }
          if (report.status !== 'failed' && parsed.success) {
            await writeFile(outputPath, `${JSON.stringify(parsed.data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            row.file = outputPath;
          }
        } else {
          const diagnosticDir = join(projectDir, '.local', 'lms', 'sync-errors');
          await mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
          const issues = result.issues;
          await writeFile(join(diagnosticDir, `${runId}-${course.id}.json`), JSON.stringify({ raw: result.lastMessage, issues }, null, 2), { mode: 0o600 });
          row.status = 'failed';
          row.reason = result.exitCode !== 0 ? result.error || '模型任务未正常完成，请检查模型配置及连接。'
            : issues.length ? `课程数据校验失败：${issues.slice(0, 3).join('；')}` : '课程结果缺失或课程身份不匹配。';
        }
        try {
          await mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
          await appendFile(usagePath, `${JSON.stringify({ at: start.toISOString(), course: course.subjectCode, model: process.env.COURSE_ANALYSIS_MODEL || (process.env.COURSE_ANALYSIS_PROVIDER === 'deepseek' ? 'deepseek-flash' : 'gpt-6-luna'),
            durationMs: Date.now() - start.getTime(), status: row.status, phases: phaseDurations, coordinator: result.usage, subagents: child })}\n`, { mode: 0o600 });
        } catch { row.reason += ' 用量记录写入失败。'; }
          } catch {
            if (cancelled) { row.status = 'cancelled'; return; }
            row.status = 'failed'; row.reason = '课程分析或保存失败，请检查本地环境。';
          }
        })());
      } catch {
        if (cancelled) { row.status = 'cancelled'; continue; }
        row.status = 'failed'; row.reason = '无法启动或记录课程任务，请检查本地环境。';
        try {
          await mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
          await appendFile(usagePath, `${JSON.stringify({ at: start.toISOString(), course: course.subjectCode, model: process.env.COURSE_ANALYSIS_MODEL || (process.env.COURSE_ANALYSIS_PROVIDER === 'deepseek' ? 'deepseek-flash' : 'gpt-6-luna'),
            durationMs: Date.now() - start.getTime(), status: row.status, coordinator: null, subagents: null })}\n`, { mode: 0o600 });
        } catch { row.reason += ' 用量记录写入失败。'; }
      }
    }
    await Promise.all(analyses);
  }

  function cancel() {
    if (!active) return state;
    cancelled = true;
    for (const row of state.courses) if (row.status === 'pending' || row.status === 'running') row.status = 'cancelled';
    for (const stop of activeStops) stop();
    return state;
  }
  return { start, cancel, status: () => state };
}

// DeepSeek Responses API: native schema output and local semantic validation.
async function runDeepSeek(prompt, registerStop) {
  const key = process.env.COURSE_ANALYSIS_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!key) return { exitCode: 1, lastMessage: '', usage: null, error: '请配置 DEEPSEEK_API_KEY 或 COURSE_ANALYSIS_API_KEY。' };
  const controller = new AbortController();
  const untrack = registerStop(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.COURSE_ANALYSIS_MODEL || 'deepseek-flash', input: prompt,
        text: { format: { type: 'json_schema', name: 'course_analysis', schema: courseOutputSchema() } } }),
    });
    if (!response.ok) return { exitCode: 1, lastMessage: '', usage: null, error: `DeepSeek 接口返回 HTTP ${response.status}。` };
    const data = await response.json();
    const lastMessage = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('');
    if (data.status !== 'completed') return { exitCode: 1, lastMessage, usage: counts(data.usage), error: `DeepSeek 结果未完成：${data.status || '未知'}。` };
    return { exitCode: 0, lastMessage, usage: counts(data.usage), threadId: null };
  } catch (error) {
    return { exitCode: 1, lastMessage: '', usage: null, error: error.name === 'AbortError' ? '模型请求已中止或超时。' : 'DeepSeek 接口连接失败。' };
  } finally { clearTimeout(timer); untrack(); }
}

// OpenAI-compatible chat-completions endpoint: credentials stay in environment.
async function runCompatible(prompt, registerStop) {
  const endpoint = process.env.COURSE_ANALYSIS_URL;
  const key = process.env.COURSE_ANALYSIS_API_KEY;
  const model = process.env.COURSE_ANALYSIS_MODEL;
  if (!endpoint || !key || !model) return { exitCode: 1, lastMessage: '', usage: null, error: '请配置 COURSE_ANALYSIS_URL、COURSE_ANALYSIS_API_KEY 和 COURSE_ANALYSIS_MODEL。' };
  let url;
  try { url = new URL(endpoint); } catch { return { exitCode: 1, lastMessage: '', usage: null, error: '模型接口地址无效。' }; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) return { exitCode: 1, lastMessage: '', usage: null, error: '模型接口必须使用 HTTPS 或本机地址。' };
  const controller = new AbortController();
  const stop = () => controller.abort();
  const untrack = registerStop(stop);
  const timer = setTimeout(stop, 15 * 60 * 1000);
  try {
    const response = await fetch(url, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    });
    if (!response.ok) return { exitCode: 1, lastMessage: '', usage: null, error: `模型接口返回 HTTP ${response.status}。` };
    const data = await response.json();
    return { exitCode: 0, lastMessage: data.choices?.[0]?.message?.content ?? '', usage: counts(data.usage), threadId: null };
  } catch (error) {
    return { exitCode: 1, lastMessage: '', usage: null, error: error.name === 'AbortError' ? '模型请求已中止或超时。' : '模型接口连接失败。' };
  } finally { clearTimeout(timer); untrack(); }
}

function runCodex(prompt, courseDir, schemaPath, cwd, registerStop, onPhase) {
  return new Promise(resolveRun => {
    let threadId = null, usage = null, lastMessage = '', completed = false, code = null;
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
      '-m', process.env.COURSE_ANALYSIS_MODEL || (process.env.COURSE_ANALYSIS_PROVIDER === 'deepseek' ? 'deepseek-flash' : 'gpt-6-luna'), '-c', 'agents.enabled=false', '--output-schema', schemaPath, '-'];
    const proc = spawn('codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let hardStop;
    const signal = name => { try { if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore' }); } else if (proc.pid) process.kill(-proc.pid, name); } catch { /* Process already exited. */ } };
    const stop = () => { signal('SIGTERM'); if (!hardStop) hardStop = setTimeout(() => signal('SIGKILL'), 5000); };
    const untrack = registerStop(stop);
    const timer = setTimeout(stop, 15 * 60 * 1000);
    const done = exitCode => { if (completed) return; completed = true; clearTimeout(timer); untrack(); resolveRun({ threadId, usage, lastMessage, exitCode }); };
    proc.on('error', () => done(null));
    proc.stderr.resume();
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') { threadId = event.thread_id; onPhase('reading'); }
      if (event.type === 'turn.completed') usage = counts(event.usage);
      if (event.type === 'turn.failed' || event.type === 'error') code = 1;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') lastMessage = event.item.text;
    });
    proc.on('close', exitCode => done(code ?? exitCode));
  });
}
