// /api/local/deeptutor: the assistant (DeepTutor) as the page sees it (decision #548). GET /status answers from what
// the server already knows, without calling the model; POST /turns starts one DeepTutor session with a preset prompt
// after the owner's click and answers with the session id, which DeepTutor's own page then opens; PUT /language tells
// DeepTutor which language the StudyOrbit page is in.
import type { RouteHandler } from '../context.ts';
import { readJsonBody, sameOriginJson } from './body.ts';

export type AssistantStatus =
  | { state: 'off' | 'starting' | 'not-installed' | 'unsupported-provider' }
  | { state: 'running' | 'external'; url: string; warning?: string }
  | { state: 'failed'; reason: string };
export type Assistant = {
  status(): AssistantStatus;
  startTurn(input: { content: string; language: 'zh' | 'en' }): Promise<{ sessionId: string }>;
  setLanguage(language: 'zh' | 'en'): Promise<void>;
  stop(): Promise<void>;
};

const TURN_LIMIT = 8000;

export function deeptutorRoute(assistant: Assistant | undefined): RouteHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    const path = (req.url ?? '/').split('?')[0];
    const method = path === '/status' ? 'GET' : path === '/turns' ? 'POST' : path === '/language' ? 'PUT' : null;
    if (!method) { json(404, { error: 'NOT_FOUND' }); return; }
    if (req.method !== method) { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    const status: AssistantStatus = assistant?.status() ?? { state: 'off' };
    if (method === 'GET') { json(200, status); return; }
    if (!sameOriginJson(req)) { res.writeHead(403).end(); return; }
    const body = await readJsonBody(req, 20000);
    if (!body.ok) { json(body.tooLarge ? 413 : 400, { error: body.tooLarge ? 'TOO_LARGE' : 'INVALID_JSON' }); return; }
    const input = body.value as { content?: unknown; language?: unknown } | null;
    const running = !!assistant && (status.state === 'running' || status.state === 'external');
    if (path === '/language') {
      if (input?.language !== 'zh' && input?.language !== 'en') { json(400, { error: 'INVALID_LANGUAGE' }); return; }
      if (!running) { json(503, { error: 'ASSISTANT_NOT_RUNNING' }); return; }
      try { await assistant.setLanguage(input.language); res.writeHead(204).end(); }
      catch { json(502, { error: 'ASSISTANT_UNAVAILABLE' }); }
      return;
    }
    const content = typeof input?.content === 'string' ? input.content.trim() : '';
    if (!content || content.length > TURN_LIMIT || (input?.language !== 'zh' && input?.language !== 'en')) { json(400, { error: 'INVALID_TURN' }); return; }
    if (!running) { json(503, { error: 'ASSISTANT_NOT_RUNNING' }); return; }
    // The cause may hold local paths; the page gets a fixed code.
    try { json(201, await assistant.startTurn({ content, language: input.language })); }
    catch { json(502, { error: 'ASSISTANT_UNAVAILABLE' }); }
  };
}
