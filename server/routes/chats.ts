// /api/local/chats: Agent chat (decisions #230, #322-#328). Conversations live in .local/chat; replies stream as
// Server-Sent Events. DeepSeek, OpenAI-compatible and Anthropic answer with the course tools; Codex keeps the full
// course context. GET / and POST / (list, create), GET and DELETE /:id, POST /:id/messages, POST /:id/stop.
import { createReplyRegistry, type ReplyRegistry } from '../../scripts/lib/chat-replies.mjs';
import { runChatReply } from '../../scripts/lib/chat-reply.mjs';
import { appendMessages, createChat, deleteChat, isChatId, listChats, readChat } from '../../scripts/lib/chat-store.mjs';
import { loadCourseReports } from '../../scripts/lib/course-reports.mjs';
import { configProblem, resolveAnalysisConfig } from '../../scripts/lib/llm-config.mjs';
import type { CourseDocument } from '../../shared/course-data.ts';
import { parsePlanningSnapshot } from '../../shared/planning-snapshot.ts';
import type { RouteContext, RouteHandler } from '../context.ts';

/** YYYY-MM-DD of `date` in `timeZone`. */
const dayIn = (date: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export function chatsRoute({ projectDir, desktopDir, env, sourceSetup }: RouteContext, chatReplies: ReplyRegistry = createReplyRegistry()): RouteHandler {
  return async (req, res) => {
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
          // Room for the planning snapshot the page sends with each message (decision #322).
          if (raw.length > 200000) { json(413, { error: 'TOO_LARGE' }); return; }
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
      // Used for this reply only and never stored.
      const planning = parsePlanningSnapshot(body.planning);
      if (!planning.ok) { json(400, { error: 'INVALID_PLANNING' }); return; }
      // Claim the chat before any await so concurrent sends cannot both pass the check.
      const controller = chatReplies.begin(id);
      if (!controller) { json(409, { error: 'REPLY_RUNNING' }); return; }
      // A closed tab stops the reply at any point, even before the event stream starts.
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      try {
        const config = await resolveAnalysisConfig(projectDir, env);
        const problem = configProblem(config);
        if (problem) { json(400, { error: problem }); return; }
        // The institution of the source settings gives the wording and the time zone of "today" and of due dates. Read
        // before the message is saved, so unusable settings leave no unanswered message behind.
        let setup;
        try { setup = await sourceSetup(); } catch { json(500, { error: 'SOURCE_SETTINGS_UNREADABLE' }); return; }
        if (controller.signal.aborted) return;
        const scope = courseIds ?? chat.courseIds;
        const userMessage = { role: 'user' as const, content, at: new Date().toISOString() };
        const updated = await appendMessages(projectDir, id, [userMessage], { courseIds: scope });
        if (!updated) { json(404, { error: 'CHAT_NOT_FOUND' }); return; }
        if (controller.signal.aborted) { res.end(); return; }
        let documents: CourseDocument[] = [], known: { id: string; code?: string; name?: string }[] = [];
        try {
          const loaded = await loadCourseReports(projectDir, { desktop: desktopDir, institution: setup.institution, canvasOrigin: setup.settings.canvasOrigin });
          documents = loaded.reports.flatMap(item => item.report ? [item.report] : []);
          known = loaded.courses.map(course => ({ id: course.id, code: course.subjectCode, name: course.name }));
        } catch { /* No synced courses yet, or a course list from another Canvas: the context says so per course. */ }
        const today = dayIn(new Date(), setup.timeZone);
        const language = body.language === 'en' ? 'en' : 'zh';
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        const result = await runChatReply({ config, messages: updated.messages, documents, courses: known, scope, today, language, planning: planning.planning, institution: setup.institution, timeZone: setup.timeZone },
          { signal: controller.signal, onDelta: text => send('delta', { text }), onStep: step => send('step', step) });
        const assistant = result.message;
        if (assistant) await appendMessages(projectDir, id, [assistant]);
        if (result.ok || result.stopped) send('done', { message: assistant, usage: result.usage, model: result.model, stopped: !!result.stopped });
        else send('error', { error: 'MODEL_ERROR', message: result.error ?? '模型没有完成回复。', message_saved: !!assistant });
        res.end();
      } finally { chatReplies.end(id, controller); }
    } catch (error) {
      if (res.headersSent) { if (!res.writableEnded) res.end(`event: error\ndata: ${JSON.stringify({ error: 'CHAT_UNAVAILABLE', message: '对话出错，请重试。' })}\n\n`); return; }
      json((error as Error).message === 'INVALID_CHAT_ID' ? 400 : 500, { error: (error as Error).message === 'INVALID_CHAT_ID' ? 'INVALID_CHAT_ID' : 'CHAT_UNAVAILABLE' });
    }
  };
}
