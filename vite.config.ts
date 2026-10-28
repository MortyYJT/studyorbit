import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterSubjects } from './scripts/lib/course-list.mjs';
import { createCourseSyncRunner } from './scripts/course-sync-runner.mjs';
import { CourseDocumentSchema } from './shared/course-data.js';

const courseFile = fileURLToPath(new URL('./.local/lms/courses.json', import.meta.url));
const projectDir = fileURLToPath(new URL('./', import.meta.url));
const courseScript = fileURLToPath(new URL('./scripts/canvas-background.mjs', import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react(), {
    name: 'local-course-candidates',
    configureServer(server) {
      let syncRunning = false;
      let discoveryProcess: ChildProcess | undefined;
      let discoveryCancelled = false;
      const courseRunner = createCourseSyncRunner(projectDir);
      server.middlewares.use('/api/local/sync-usage', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const raw = await readFile(join(projectDir, '.local', 'lms', 'course-sync-usage.jsonl'), 'utf8');
          const items = raw.split('\n').filter(Boolean).slice(-1000).flatMap(line => {
            try {
              const row = JSON.parse(line);
              const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
              const usage = (value: any) => value && typeof value === 'object' ? { input: count(value.input), output: count(value.output), cached: count(value.cached), reasoning: count(value.reasoning) } : null;
              return [{ type: typeof row.type === 'string' ? row.type : 'course', runId: typeof row.runId === 'string' ? row.runId : '', at: typeof row.at === 'string' ? row.at : '', course: typeof row.course === 'string' ? row.course : '', courses: Array.isArray(row.courses) ? row.courses.flatMap((value: unknown) => typeof value === 'string' ? [{ code: value, status: '' }] : value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string' ? [{ code: (value as { code: string }).code, status: typeof (value as { status?: unknown }).status === 'string' ? (value as { status: string }).status : '' }] : []) : [], model: typeof row.model === 'string' ? row.model : '', status: typeof row.status === 'string' ? row.status : '', durationMs: count(row.durationMs), coordinator: usage(row.coordinator), subagents: usage(row.subagents), recovered: false }];
            } catch { return []; }
          });
          // Older logs lack run IDs. Recover only unique matches to a saved run/course directory's creation time.
          try {
            const input = JSON.parse(await readFile(courseFile, 'utf8'));
            const courses: { id: string; code?: unknown }[] = (Array.isArray(input.courses) ? input.courses : []).filter((course: unknown): course is { id: string; code?: unknown } => !!course && typeof course === 'object' && typeof (course as { id?: unknown }).id === 'string');
            const candidates = filterSubjects(courses);
            const codes = new Map(candidates.map(course => [course.id, course.subjectCode]));
            const root = join(projectDir, '.local', 'lms', 'runs');
            const runs = await Promise.all((await readdir(root)).map(async runId => {
              try {
                const directory = join(root, runId);
                const ids = await readdir(directory);
                const courses = await Promise.all(ids.map(async id => {
                  try { const info = await stat(join(directory, id)); return info.isDirectory() && codes.has(id) ? { code: codes.get(id) as string, birth: info.birthtimeMs } : null; }
                  catch { return null; }
                }));
                return { runId, courses: courses.filter((value): value is { code: string; birth: number } => value !== null).sort((a, b) => a.birth - b.birth) };
              } catch { return { runId, courses: [] }; }
            }));
            for (const row of items) {
              if (row.runId || row.type !== 'course' || !row.course || !Number.isFinite(Date.parse(row.at))) continue;
              const matches = runs.filter(run => run.courses.some(course => course.code === row.course && Math.abs(course.birth - Date.parse(row.at)) <= 2));
              if (matches.length === 1) { row.runId = matches[0]!.runId; row.recovered = true; }
            }
            for (const run of runs) {
              const rows = items.filter(row => row.recovered && row.runId === run.runId);
              if (!rows.length) continue;
              const started = Math.min(...rows.map(row => Date.parse(row.at)));
              const complete = run.courses.length === rows.length && run.courses.every(course => rows.filter(row => row.course === course.code).length === 1) && rows.every(row => row.durationMs !== null);
              const elapsed = complete ? Math.max(...rows.map(row => Date.parse(row.at) + row.durationMs!)) - started : null;
              const courses = run.courses.map(course => ({ code: course.code, status: rows.find(row => row.course === course.code)?.status ?? '' }));
              items.push({ type: 'batch_end', runId: run.runId, at: new Date(started + (elapsed ?? 0)).toISOString(), course: '', courses, model: '', status: '', durationMs: elapsed, coordinator: null, subagents: null, recovered: true });
              items.push({ type: 'batch_start', runId: run.runId, at: new Date(started).toISOString(), course: '', courses, model: '', status: '', durationMs: null, coordinator: null, subagents: null, recovered: true });
            }
          } catch { /* Keep old records separate if run metadata cannot be verified. */ }
          items.reverse();
          res.end(JSON.stringify({ items }));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') res.end(JSON.stringify({ items: [] }));
          else res.writeHead(500).end(JSON.stringify({ error: 'USAGE_UNAVAILABLE' }));
        }
      });
      server.middlewares.use('/api/local/course-reports', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const input = JSON.parse(await readFile(courseFile, 'utf8'));
          if (!Array.isArray(input.courses)) throw new Error('Invalid course file');
          const candidates: { id: string; name: string; code?: unknown; term?: string | null }[] = input.courses.filter((item: unknown): item is { id: string; name: string; code?: unknown; term?: string | null } =>
            !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { name?: unknown }).name === 'string');
          const courses = filterSubjects(candidates);
          const reports = await Promise.all(courses.map(async course => {
            if (!/^[A-Z]{4}[1-9]\d{4}$/.test(course.subjectCode)) return null;
            const term = typeof course.term === 'string' ? course.term : '';
            const match = /(20\d{2}).*?(?:semester|sem)\s*([12])/i.exec(term);
            const label = match ? `${match[1]} S${match[2]}` : term.replace(/[^\w\u4e00-\u9fff -]/g, '').trim().slice(0, 50) || '未知学期';
            const dir = join(homedir(), 'Desktop', `墨尔本大学 ${label}`, course.subjectCode);
            try {
              const names = (await readdir(dir)).filter(name => /^分数结构(?:-[a-zA-Z0-9-]+)?\.json$/.test(name));
              const files = await Promise.all(names.map(async name => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
              files.sort((a, b) => b.mtime - a.mtime);
              for (const file of files) {
                try {
                  const data = CourseDocumentSchema.safeParse(JSON.parse(await readFile(join(dir, file.name), 'utf8')));
                  if (data.success && data.data.course.id === course.id) return { id: course.id, report: data.data };
                } catch { /* Older valid reports may still be usable. */ }
              }
            } catch { /* A selected course may not have a report yet. */ }
            return { id: course.id, report: null };
          }));
          res.end(JSON.stringify({ courses, reports: reports.filter(Boolean) }));
        } catch (error) {
          res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end(JSON.stringify({ error: 'COURSES_UNAVAILABLE' }));
        }
      });
      server.middlewares.use('/api/local/course-sync', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET') { res.end(JSON.stringify(courseRunner.status())); return; }
        if (req.method !== 'POST' && req.method !== 'DELETE') { res.writeHead(405).end(); return; }
        if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
          || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
        if (req.method === 'DELETE') { res.end(JSON.stringify(courseRunner.cancel())); return; }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 10000) throw new Error('INVALID_SELECTION');
          }
          const data = JSON.parse(body);
          if (!data || Object.keys(data).length !== 1 || !Array.isArray(data.ids)) throw new Error('INVALID_SELECTION');
          const state = await courseRunner.start(data.ids);
          res.writeHead(202).end(JSON.stringify(state));
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'INVALID_SELECTION';
          res.writeHead(reason === 'SYNC_RUNNING' ? 409 : 400).end(JSON.stringify({ error: reason }));
        }
      });
      server.middlewares.use('/api/local/sync-courses', (req, res) => {
        const remote = req.socket.remoteAddress;
        const origin = req.headers.origin;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
          || !origin || origin !== `http://${req.headers.host}`) {
          res.writeHead(403).end(); return;
        }
        if (req.method === 'DELETE') {
          discoveryCancelled = true;
          if (discoveryProcess?.pid) { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(discoveryProcess.pid), '/t', '/f']); else process.kill(-discoveryProcess.pid, 'SIGTERM'); } catch { /* already exited */ } }
          res.writeHead(200).end(JSON.stringify({ ok: true })); return;
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        if (syncRunning) { res.writeHead(409).end(); return; }
        syncRunning = true;
        discoveryCancelled = false;
        discoveryProcess = execFile(process.execPath, [courseScript, 'discover', courseFile], { cwd: projectDir, timeout: 45000, maxBuffer: 1024 * 1024, detached: process.platform !== 'win32' } as ExecFileOptionsWithStringEncoding, (error, _stdout, stderr) => {
          syncRunning = false;
          discoveryProcess = undefined;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (discoveryCancelled) { res.writeHead(409).end(JSON.stringify({ error: 'SYNC_CANCELLED' })); return; }
          if (error) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: stderr.trim().slice(0, 2000) || '获取课程失败。' }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, ...(stderr.trim() ? { warning: stderr.trim().slice(0, 1000) } : {}) }));
        });
      });
      server.middlewares.use('/api/local/course-candidates', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
          res.writeHead(403).end(); return;
        }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        try {
          const data = JSON.parse(await readFile(courseFile, 'utf8'));
          if (!data || !Array.isArray(data.courses)) throw new Error('Invalid course file');
          const courses = filterSubjects(data.courses.filter((course: unknown) =>
            course && typeof course === 'object' && typeof (course as { id?: unknown }).id === 'string'
            && typeof (course as { name?: unknown }).name === 'string'));
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ courses, fetchedAt: data.fetchedAt, scope: data.scope }));
        } catch (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          res.writeHead(missing ? 404 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: missing ? 'COURSES_NOT_FOUND' : 'COURSES_UNAVAILABLE' }));
        }
      });
    },
  }],
  build: { outDir: '../dist', emptyOutDir: true },
});
