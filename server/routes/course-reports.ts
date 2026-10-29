// GET /api/local/course-reports: course candidates and each course's newest valid Desktop course document, under the
// institution of the source settings. A course list from another Canvas than the settings' is refused with
// `409 COURSE_LIST_STALE` (generic-adapters design §2).
import { loadCourseReports } from '../../scripts/lib/course-reports.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function courseReportsRoute({ projectDir, desktopDir, sourceSetup }: RouteContext): RouteHandler {
  return async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    let setup;
    try { setup = await sourceSetup(); } catch { res.writeHead(500).end(JSON.stringify({ error: 'SOURCE_SETTINGS_UNREADABLE' })); return; }
    try {
      res.end(JSON.stringify(await loadCourseReports(projectDir, { desktop: desktopDir, institution: setup.institution, canvasOrigin: setup.settings.canvasOrigin })));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'COURSE_LIST_STALE') { res.writeHead(409).end(JSON.stringify({ error: 'COURSE_LIST_STALE' })); return; }
      res.writeHead(code === 'ENOENT' ? 404 : 500).end(JSON.stringify({ error: 'COURSES_UNAVAILABLE' }));
    }
  };
}
