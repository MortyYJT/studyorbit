import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterSubjects } from './scripts/lib/course-list.mjs';
import { createCourseSyncRunner } from './scripts/course-sync-runner.mjs';
import { LlmConfigValidationError, configProblem, publicLlmConfig, readLlmConfig, resolveAnalysisConfig, saveLlmConfig } from './scripts/lib/llm-config.mjs';
import { chat as streamChat, testConnection, type ChatTurn } from './scripts/lib/llm-providers.mjs';
import { appendMessages, createChat, deleteChat, isChatId, listChats, readChat } from './scripts/lib/chat-store.mjs';
import { buildChatContext, chatSystemPrompt } from './scripts/lib/chat-context.mjs';
import { createNote, deleteNote, listNotes } from './scripts/lib/revision-store.mjs';
import { loadCourseReports } from './scripts/lib/course-reports.mjs';
import { createReplyRegistry } from './scripts/lib/chat-replies.mjs';
import { foreignOrigin } from './scripts/lib/local-origin.mjs';
import type { CourseDocument } from './shared/course-data.js';

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
      // Every local API route, GET included, refuses requests from any other origin (other local ports too).
      server.middlewares.use('/api/local', (req, res, next) => {
        if (foreignOrigin({ origin: req.headers.origin, host: req.headers.host })) { res.writeHead(403).end(); return; }
        next();
      });
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
      // Analysis model settings (decision #229). The key is write-only: responses never include it.
      let llmTestRunning = false;
      server.middlewares.use('/api/local/llm-config', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const path = (req.url ?? '/').split('?')[0];
        if (path === '/' && req.method === 'GET') { res.end(JSON.stringify(publicLlmConfig(await readLlmConfig(projectDir), process.env))); return; }
        const isSave = path === '/' && req.method === 'PUT', isTest = path === '/test' && req.method === 'POST';
        if (!isSave && !isTest) { res.writeHead(path === '/' || path === '/test' ? 405 : 404).end(); return; }
        if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
          || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 10000) { res.writeHead(413).end(JSON.stringify({ error: 'TOO_LARGE' })); return; }
          }
          if (isTest) {
            if (llmTestRunning) { res.writeHead(409).end(JSON.stringify({ error: 'TEST_RUNNING' })); return; }
            llmTestRunning = true;
            try { res.end(JSON.stringify(await testConnection(await resolveAnalysisConfig(projectDir, process.env)))); }
            finally { llmTestRunning = false; }
            return;
          }
          let input: unknown;
          try { input = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'INVALID_LLM_CONFIG', fieldErrors: { form: 'invalid_json' } })); return; }
          const saved = await saveLlmConfig(projectDir, input);
          res.end(JSON.stringify(publicLlmConfig(saved, process.env)));
        } catch (error) {
          if (error instanceof LlmConfigValidationError) res.writeHead(400).end(JSON.stringify({ error: 'INVALID_LLM_CONFIG', fieldErrors: error.fieldErrors }));
          else res.writeHead(500).end(JSON.stringify({ error: 'LLM_CONFIG_UNAVAILABLE' }));
        }
      });
      server.middlewares.use('/api/local/course-reports', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        try {
          res.end(JSON.stringify(await loadCourseReports(projectDir)));
        } catch (error) {
          res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end(JSON.stringify({ error: 'COURSES_UNAVAILABLE' }));
        }
      });
      // Revision notes saved from Agent replies (decision #236). GET ?courseId=, POST, DELETE /:id; stored in .local/revision.
      server.middlewares.use('/api/local/revision-notes', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        res.setHeader('Cache-Control', 'no-store');
        const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
        const [path, query = ''] = (req.url ?? '/').split('?');
        const parts = path!.split('/').filter(Boolean);
        const allowed = parts.length === 0 ? ['GET', 'POST'] : parts.length === 1 ? ['DELETE'] : [];
        if (!allowed.length) { json(404, { error: 'NOT_FOUND' }); return; }
        if (!allowed.includes(req.method ?? '')) { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
        if (req.method !== 'GET' && (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
          || req.headers['content-type']?.split(';')[0] !== 'application/json')) { res.writeHead(403).end(); return; }
        const known = ['INVALID_COURSE_ID', 'INVALID_NOTE_ID', 'CONTENT_EMPTY', 'CONTENT_TOO_LONG', 'TOO_MANY_NOTES'];
        try {
          if (req.method === 'GET') { json(200, { notes: await listNotes(projectDir, new URLSearchParams(query).get('courseId') ?? '') }); return; }
          if (req.method === 'DELETE') { if (await deleteNote(projectDir, parts[0]!)) json(200, { ok: true }); else json(404, { error: 'NOTE_NOT_FOUND' }); return; }
          // Decode once after collecting the bytes: a UTF-8 character can be split across chunks.
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) {
            chunks.push(chunk as Buffer); size += (chunk as Buffer).length;
            if (size > 100000) { json(413, { error: 'TOO_LARGE' }); return; }
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown>;
          try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape'); body = parsed as Record<string, unknown>; }
          catch { json(400, { error: 'INVALID_JSON' }); return; }
          json(201, await createNote(projectDir, { courseId: body.courseId, content: body.content, chatId: body.chatId }));
        } catch (error) {
          const code = (error as Error).message;
          json(known.includes(code) ? (code === 'TOO_MANY_NOTES' ? 409 : 400) : 500, { error: known.includes(code) ? code : 'REVISION_UNAVAILABLE' });
        }
      });
      // Agent chat (decision #230). Conversations live in .local/chat; replies stream as Server-Sent Events.
      const chatReplies = createReplyRegistry();
      server.middlewares.use('/api/local/chats', async (req, res) => {
        const remote = req.socket.remoteAddress;
        if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
        res.setHeader('Cache-Control', 'no-store');
        const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
        const parts = (req.url ?? '/').split('?')[0]!.split('/').filter(Boolean);
        const [id, action] = parts;
        if (parts.length > 2 || (action && action !== 'messages' && action !== 'stop')) { json(404, { error: 'NOT_FOUND' }); return; }
        if (id && !isChatId(id)) { json(400, { error: 'INVALID_CHAT_ID' }); return; }
        const allowed = !id ? ['GET', 'POST'] : !action ? ['GET', 'DELETE'] : ['POST'];
        if (!allowed.includes(req.method ?? '')) { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
        if (req.method !== 'GET' && (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
          || req.headers['content-type']?.split(';')[0] !== 'application/json')) { res.writeHead(403).end(); return; }
        try {
          let body: Record<string, unknown> = {};
          if (req.method === 'POST') {
            let raw = '';
            for await (const chunk of req) {
              raw += chunk.toString();
              if (raw.length > 40000) { json(413, { error: 'TOO_LARGE' }); return; }
            }
            try { const parsed: unknown = raw.trim() ? JSON.parse(raw) : {}; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape'); body = parsed as Record<string, unknown>; }
            catch { json(400, { error: 'INVALID_JSON' }); return; }
          }
          const courseIds = body.courseIds === undefined ? undefined
            : Array.isArray(body.courseIds) && body.courseIds.length <= 100 && body.courseIds.every(value => typeof value === 'string' && value.length > 0 && value.length <= 200) ? body.courseIds as string[] : null;
          if (courseIds === null) { json(400, { error: 'INVALID_COURSE_IDS' }); return; }
          if (!id && req.method === 'GET') { json(200, { chats: (await listChats(projectDir)).map(chat => ({ ...chat, running: chatReplies.running(chat.id) })) }); return; }
          if (!id) { json(201, await createChat(projectDir, { courseIds, title: typeof body.title === 'string' ? body.title : undefined })); return; }
          if (req.method === 'DELETE') {
            // Let a running reply save its partial text first, so it cannot recreate the file after deletion.
            await chatReplies.stopAndWait(id);
            if (await deleteChat(projectDir, id)) json(200, { ok: true }); else json(404, { error: 'CHAT_NOT_FOUND' });
            return;
          }
          const chat = await readChat(projectDir, id);
          if (!chat) { json(404, { error: 'CHAT_NOT_FOUND' }); return; }
          if (req.method === 'GET') { json(200, { ...chat, running: chatReplies.running(id) }); return; }
          if (action === 'stop') { json(200, { ok: true, stopped: chatReplies.stop(id) }); return; }

          // POST /:id/messages
          const content = typeof body.content === 'string' ? body.content.trim() : '';
          if (!content) { json(400, { error: 'CONTENT_EMPTY' }); return; }
          if (content.length > 8000) { json(400, { error: 'CONTENT_TOO_LONG' }); return; }
          // Claim the chat before any await so concurrent sends cannot both pass the check.
          const controller = chatReplies.begin(id);
          if (!controller) { json(409, { error: 'REPLY_RUNNING' }); return; }
          // A closed tab stops the reply at any point, even before the event stream starts.
          res.on('close', () => { if (!res.writableFinished) controller.abort(); });
          try {
            const config = await resolveAnalysisConfig(projectDir, process.env);
            const problem = configProblem(config);
            if (problem) { json(400, { error: problem }); return; }
            if (controller.signal.aborted) return;
            const scope = courseIds ?? chat.courseIds;
            const userMessage = { role: 'user' as const, content, at: new Date().toISOString() };
            const updated = await appendMessages(projectDir, id, [userMessage], { courseIds: scope });
            if (!updated) { json(404, { error: 'CHAT_NOT_FOUND' }); return; }
            if (controller.signal.aborted) { res.end(); return; }
            let documents: CourseDocument[] = [], known: { id: string; code?: string; name?: string }[] = [];
            try {
              const loaded = await loadCourseReports(projectDir);
              documents = loaded.reports.flatMap(item => item.report ? [item.report] : []);
              known = loaded.courses.map(course => ({ id: course.id, code: course.subjectCode, name: course.name }));
            } catch { /* No synced courses yet: the context says so per course. */ }
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
            const language = body.language === 'en' ? 'en' : 'zh';
            const system = `${chatSystemPrompt(language)}\n\n# 课程数据\n\n${buildChatContext(documents, { today, courseIds: scope, courses: known })}`;
            // Keep the most recent turns within a fixed budget so long chats do not grow without bound.
            const history: ChatTurn[] = [];
            let budget = 60000;
            for (const message of [...updated.messages].reverse()) {
              if (!message.content) continue;
              budget -= message.content.length;
              if (budget < 0 && history.length) break;
              history.unshift({ role: message.role, content: message.content });
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            const result = await streamChat(config, { system, messages: history }, { signal: controller.signal, onDelta: text => send('delta', { text }) });
            const status = result.stopped ? 'stopped' as const : result.ok ? undefined : 'error' as const;
            const assistant = result.text || result.ok
              ? { role: 'assistant' as const, content: result.text, at: new Date().toISOString(), usage: result.usage, model: result.model, ...(status ? { status } : {}) }
              : null;
            if (assistant) await appendMessages(projectDir, id, [assistant]);
            if (result.ok || result.stopped) send('done', { message: assistant, usage: result.usage, model: result.model, stopped: !!result.stopped });
            else send('error', { error: 'MODEL_ERROR', message: result.error ?? '模型没有完成回复。', message_saved: !!assistant });
            res.end();
          } finally { chatReplies.end(id, controller); }
        } catch (error) {
          if (res.headersSent) { if (!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify({ error: 'CHAT_UNAVAILABLE', message: '对话出错，请重试。' })}\n\n`); return; }
          json((error as Error).message === 'INVALID_CHAT_ID' ? 400 : 500, { error: (error as Error).message === 'INVALID_CHAT_ID' ? 'INVALID_CHAT_ID' : 'CHAT_UNAVAILABLE' });
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
  // No CORS: the local API is same-origin only (see the /api/local guard). HMR uses the WebSocket, not CORS.
  server: { cors: false },
  build: { outDir: '../dist', emptyOutDir: true },
});
