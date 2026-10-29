// /api/local/source-settings: data-source settings (openspec change generic-adapters, design §8, decision #447).
// GET returns the effective settings, whether they were saved, the platform and the choices available on it; PUT
// validates, writes `.local/config/sources.json` atomically and returns the same. A write needs an exact Origin and
// JSON, like the other write routes, and is refused with `409 SYNC_RUNNING` while a sync or course discovery runs, so a
// running sync keeps the settings it read.
import {
  availableChoices, effectiveSourceSettings, loadSourceSettings, saveSourceSettings, SourceSettingsError, type SourceSettings,
} from '../../scripts/lib/source-settings.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export type SourceSettingsReply = {
  settings: ReturnType<typeof effectiveSourceSettings>; saved: boolean; platform: string; available: ReturnType<typeof availableChoices>;
};

/** `busy()` is true while a sync or discovery runs; `isFile` checks a browser path (tests swap in a fake). */
export function sourceSettingsRoute({ projectDir, platform }: RouteContext, busy: () => boolean, isFile?: (path: string) => Promise<boolean>): RouteHandler {
  const reply = (settings: SourceSettings, saved: boolean): SourceSettingsReply => ({ settings: effectiveSourceSettings(settings), saved, platform, available: availableChoices(platform) });
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/') { res.writeHead(404).end(JSON.stringify({ error: 'NOT_FOUND' })); return; }
    if (req.method === 'GET') {
      try {
        const { settings, saved } = await loadSourceSettings(projectDir, { platform });
        res.end(JSON.stringify(reply(settings, saved)));
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: 'SOURCE_SETTINGS_UNREADABLE' }));
      }
      return;
    }
    if (req.method !== 'PUT') { res.writeHead(405).end(); return; }
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 10000) { res.writeHead(413).end(JSON.stringify({ error: 'TOO_LARGE' })); return; }
    }
    if (busy()) { res.writeHead(409).end(JSON.stringify({ error: 'SYNC_RUNNING' })); return; }
    let input: unknown;
    try { input = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'INVALID_SOURCE_SETTINGS', field: null, reason: '请求格式错误' })); return; }
    try {
      const saved = await saveSourceSettings(projectDir, input, {
        platform, ...(isFile ? { isFile } : {}),
        // Checked again right before the rename: a sync or discovery that started meanwhile keeps the old file.
        beforeWrite: () => { if (busy()) throw new SourceSettingsError('SYNC_RUNNING'); },
      });
      res.end(JSON.stringify(reply(saved, true)));
    } catch (error) {
      if (error instanceof SourceSettingsError && error.code === 'SYNC_RUNNING') res.writeHead(409).end(JSON.stringify({ error: 'SYNC_RUNNING' }));
      else if (error instanceof SourceSettingsError && error.code === 'INVALID_SOURCE_SETTINGS') res.writeHead(400).end(JSON.stringify({ error: error.code, field: error.field, reason: error.reason }));
      else res.writeHead(500).end(JSON.stringify({ error: 'SOURCE_SETTINGS_UNAVAILABLE' }));
    }
  };
}
