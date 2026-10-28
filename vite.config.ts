import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterSubjects } from './scripts/lib/course-list.mjs';
import { createCourseSyncRunner } from './scripts/course-sync-runner.mjs';
import { CourseDocumentSchema } from './shared/course-data.js';

const courseFile = fileURLToPath(new URL('./.local/lms/courses.json', import.meta.url));
const projectDir = fileURLToPath(new URL('./', import.meta.url));
const courseScript = fileURLToPath(new URL('./scripts/get-courses.mjs', import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react(), {
    name: 'local-course-candidates',
    configureServer(server) {
      let syncRunning = false;
      const courseRunner = createCourseSyncRunner(projectDir);
      server.middlewares.use('/api/local/course-reports', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const input = JSON.parse(await readFile(courseFile, 'utf8'));
          if (!Array.isArray(input.courses)) throw new Error('Invalid course file');
          const candidates = input.courses.filter((item: unknown): item is { id: string; name: string; code?: unknown; term?: string | null } =>
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
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
          || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
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
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        if (syncRunning) { res.writeHead(409).end(); return; }
        syncRunning = true;
        execFile(process.execPath, [courseScript], { cwd: projectDir, timeout: 45000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
          syncRunning = false;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
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
