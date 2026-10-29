// /api/local/llm-config: analysis model settings (decision #229). GET /, PUT / (save), POST /test (connection test).
// The key is write-only: responses never include it.
import { LlmConfigValidationError, publicLlmConfig, readLlmConfig, resolveAnalysisConfig, saveLlmConfig } from '../../scripts/lib/llm-config.mjs';
import { testConnection } from '../../scripts/lib/llm-providers.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function llmConfigRoute({ projectDir, env }: RouteContext): RouteHandler {
  let llmTestRunning = false;
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' && req.method === 'GET') { res.end(JSON.stringify(publicLlmConfig(await readLlmConfig(projectDir), env))); return; }
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
        try { res.end(JSON.stringify(await testConnection(await resolveAnalysisConfig(projectDir, env)))); }
        finally { llmTestRunning = false; }
        return;
      }
      let input: unknown;
      try { input = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'INVALID_LLM_CONFIG', fieldErrors: { form: 'invalid_json' } })); return; }
      const saved = await saveLlmConfig(projectDir, input);
      res.end(JSON.stringify(publicLlmConfig(saved, env)));
    } catch (error) {
      if (error instanceof LlmConfigValidationError) res.writeHead(400).end(JSON.stringify({ error: 'INVALID_LLM_CONFIG', fieldErrors: error.fieldErrors }));
      else res.writeHead(500).end(JSON.stringify({ error: 'LLM_CONFIG_UNAVAILABLE' }));
    }
  };
}
