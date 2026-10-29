// /api/local/browser/open: 「打开专用浏览器」 (openspec change generic-adapters, design §7, decision #446). With the
// experimental CDP bridge the local server owns one dedicated browser; this route launches it if needed and opens the
// Canvas address in a new tab, where the owner signs in (single sign-on and MFA included). StudyOrbit never types
// credentials. Same access rules as the other write routes: exact Origin and a JSON request.
import type { CdpHost } from '../../scripts/browser/cdp-host.mjs';
import { PROFILE_IN_USE } from '../../scripts/browser/cdp-launch.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function browserRoute(context: RouteContext, host: CdpHost): RouteHandler {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/open') { res.writeHead(404).end(JSON.stringify({ error: 'NOT_FOUND' })); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`
      || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end(); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 1000) { res.writeHead(413).end(JSON.stringify({ error: 'TOO_LARGE' })); return; }
    }
    let setup;
    try { setup = await context.sourceSetup(); } catch {
      res.writeHead(500).end(JSON.stringify({ error: 'SOURCE_SETTINGS_UNREADABLE' }));
      return;
    }
    const { browser, browserPath, canvasOrigin } = setup.settings;
    if (!browser.startsWith('cdp-')) {
      res.writeHead(409).end(JSON.stringify({ error: 'NOT_DEDICATED_BROWSER', reason: '当前设置的浏览器不是专用浏览器' }));
      return;
    }
    try {
      await host.openSignIn({ browser, browserPath, canvasOrigin });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const reason = String((error as Error)?.message ?? error).slice(0, 500);
      if (reason === PROFILE_IN_USE) res.writeHead(409).end(JSON.stringify({ error: 'BROWSER_PROFILE_IN_USE', reason }));
      else res.writeHead(500).end(JSON.stringify({ error: 'BROWSER_UNAVAILABLE', reason }));
    }
  };
}
