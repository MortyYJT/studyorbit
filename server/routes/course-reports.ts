// GET /api/local/course-reports: course candidates and each course's newest valid Desktop course document.
import { loadCourseReports } from '../../scripts/lib/course-reports.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function courseReportsRoute({ projectDir, desktopDir }: RouteContext): RouteHandler {
  return async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.end(JSON.stringify(await loadCourseReports(projectDir, { desktop: desktopDir })));
    } catch (error) {
      res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end(JSON.stringify({ error: 'COURSES_UNAVAILABLE' }));
    }
  };
}
