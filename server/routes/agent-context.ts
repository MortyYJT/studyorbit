// /api/local/agent-context: PUT stores the page context for the MCP server (decision #546): the course selection, the
// course the owner is asking about and the planning snapshot. Write-only; the MCP server reads the file.
import { AGENT_CONTEXT_LIMIT, parseAgentContext, writeAgentContext } from '../../scripts/lib/agent-context.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';
import { readJsonBody, sameOriginJson } from './body.ts';

export function agentContextRoute({ projectDir }: RouteContext): RouteHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
    if ((req.url ?? '/').split('?')[0] !== '/') { json(404, { error: 'NOT_FOUND' }); return; }
    if (req.method !== 'PUT') { json(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    if (!sameOriginJson(req)) { res.writeHead(403).end(); return; }
    const body = await readJsonBody(req, AGENT_CONTEXT_LIMIT);
    if (!body.ok) { json(body.tooLarge ? 413 : 400, { error: body.tooLarge ? 'TOO_LARGE' : 'INVALID_JSON' }); return; }
    const parsed = parseAgentContext(body.value);
    if (!parsed.ok) { json(400, { error: 'INVALID_CONTEXT' }); return; }
    try { json(200, { ok: true, savedAt: (await writeAgentContext(projectDir, parsed.context)).savedAt }); }
    catch (error) { if ((error as Error).message === 'TOO_LARGE') json(413, { error: 'TOO_LARGE' }); else json(500, { error: 'CONTEXT_UNAVAILABLE' }); }
  };
}
