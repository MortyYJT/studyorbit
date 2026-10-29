// /api/local/corrections: owner corrections, manual assessments and order lists per course in .local/corrections
// (decisions #290-#295). The store and its request handling live in scripts/lib/corrections-store.mjs; the base of a
// new store is the course's newest valid course file, read the same way as the course-reports route.
import { createCorrectionsHandler, createCorrectionsStore } from '../../scripts/lib/corrections-store.mjs';
import { loadCourseReports } from '../../scripts/lib/course-reports.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function correctionsRoute({ projectDir, desktopDir }: RouteContext): RouteHandler {
  const handle = createCorrectionsHandler(createCorrectionsStore({
    projectDir,
    loadDocument: async courseId => {
      try { return (await loadCourseReports(projectDir, { desktop: desktopDir })).reports.find(item => item.id === courseId)?.report ?? null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
  }));
  return (req, res) => { void handle(req, res); };
}
