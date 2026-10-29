import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { filterSubjects } from './lib/course-list.mjs';
import { courseOutputSchema, buildAnalysisPrompt } from './lib/course-analysis.mjs';
import { analyseWithRepair, settleCourse, validateAnalysis } from './lib/course-validation.mjs';
import { newestCourseDocument } from './lib/course-reports.mjs';
import { configProblem, resolveAnalysisConfig } from './lib/llm-config.mjs';
import { analyse, counts } from './lib/llm-providers.mjs';

const codePattern = /^[A-Z]{4}[1-9]\d{4}$/;

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
      // Resolve the model once per sync: saved settings > environment variables > defaults (decision #229).
      const analysisConfig = await resolveAnalysisConfig(projectDir, process.env);
      const problem = configProblem(analysisConfig);
      if (problem) throw new Error(problem);
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('INVALID_SELECTION');
      const input = JSON.parse(await readFile(join(projectDir, '.local', 'lms', 'courses.json'), 'utf8'));
      if (!Array.isArray(input.courses)) throw new Error('COURSES_UNAVAILABLE');
      const candidates = filterSubjects(input.courses.filter(item => item && typeof item.id === 'string'));
      const selected = ids.map(id => candidates.find(item => item.id === id));
      if (selected.some(item => !item || !codePattern.test(item.subjectCode))) throw new Error('INVALID_SELECTION');
      await mkdir(dirname(schemaPath), { recursive: true });
      await writeFile(schemaPath, JSON.stringify(courseOutputSchema(), null, 2), { mode: 0o600 });
      const runId = randomUUID();
      const batchStart = Date.now();
      await mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
      await appendFile(usagePath, `${JSON.stringify({ type: 'batch_start', runId, at: new Date(batchStart).toISOString(), courses: selected.map(course => course.subjectCode) })}\n`, { mode: 0o600 });
      state = { running: true, courses: selected.map(course => ({ id: course.id, code: course.subjectCode, status: 'pending', reason: '' })), error: null };
      void runSequential(selected, runId, analysisConfig).catch(() => {
        state.error = '同步任务异常中断，请检查本地环境。';
        for (const course of state.courses) if (course.status === 'pending' || course.status === 'running') course.status = 'failed';
      }).finally(async () => {
        try {
          await appendFile(usagePath, `${JSON.stringify({ type: 'batch_end', runId, at: new Date().toISOString(), durationMs: Date.now() - batchStart, courses: state.courses.map(({ code, status }) => ({ code, status })) })}\n`, { mode: 0o600 });
        } catch { state.error = '同步记录保存失败。'; }
        state.running = false; active = false;
      });
      return state;
    } catch (error) { active = false; throw error; }
  }

  async function runSequential(courses, runId, analysisConfig) {
    const schema = courseOutputSchema();
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
        const edData = JSON.parse(await readFile(edPath, 'utf8'));
        const handbookData = JSON.parse(await readFile(handbookPath, 'utf8'));
        const instructions = buildAnalysisPrompt({ course, term, canvas: canvasData, ed: edData, handbook: handbookData });
        if (cancelled) { row.status = 'cancelled'; return; }
        const { result, validation, attempts } = await analyseWithRepair({
          instructions,
          run: prompt => analyse(analysisConfig, prompt, { schema, schemaPath, cwd: projectDir, registerStop: trackStop, onPhase: () => { row.phase = 'analysis'; } }),
          validate: raw => validateAnalysis(raw, { course, canvas: canvasData, ed: edData, handbook: handbookData }),
          isCancelled: () => cancelled,
        });
        if (attempts.length > 1) {
          const diagnosticDir = join(projectDir, '.local', 'lms', 'sync-errors');
          await mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
          await writeFile(join(diagnosticDir, `${runId}-${course.id}-attempts.json`), JSON.stringify(attempts, null, 2), { mode: 0o600 });
        }
        phaseDurations.analysisMs = Date.now() - analysisStarted;
        if (cancelled) {
          row.status = 'cancelled';
          const child = await childUsage(result.threadId, start);
          await mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
          await appendFile(usagePath, `${JSON.stringify({ runId, at: start.toISOString(), course: course.subjectCode, model: analysisConfig.model, durationMs: Date.now() - start.getTime(), status: 'cancelled', phases: phaseDurations, coordinator: result.usage, subagents: child })}\n`, { mode: 0o600 });
          return;
        }
        row.phase = 'saving';
        const child = await childUsage(result.threadId, start);
        if (cancelled) { row.status = 'cancelled'; return; }
        // The newest valid earlier document of this course (v1 or v2) gives the legacy ID map of the new one.
        const previous = await newestCourseDocument(courseDir, course.id);
        const settled = settleCourse({ result, validation, collection: {
          canvasFailed: canvas.code !== 0, canvasUnpaginated: canvasData.paginationVerified === false,
          edFailed: ed.code !== 0, edPartial: edData.status === 'partial', handbookFailed: handbook.code !== 0,
        }, data: { canvas: canvasData, ed: edData, handbook: handbookData }, previous });
        row.status = settled.status;
        row.reason = settled.reason;
        if (settled.diagnostic) {
          const diagnosticDir = join(projectDir, '.local', 'lms', 'sync-errors');
          await mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
          await writeFile(join(diagnosticDir, `${runId}-${course.id}.json`), JSON.stringify(settled.diagnostic, null, 2), { mode: 0o600 });
        }
        if (settled.document) {
          await writeFile(outputPath, `${JSON.stringify(settled.document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
          row.file = outputPath;
        }
        try {
          await mkdir(dirname(usagePath), { recursive: true, mode: 0o700 });
          await appendFile(usagePath, `${JSON.stringify({ runId, at: start.toISOString(), course: course.subjectCode, model: analysisConfig.model,
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
          await appendFile(usagePath, `${JSON.stringify({ runId, at: start.toISOString(), course: course.subjectCode, model: analysisConfig.model,
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
