// GET /api/local/course-changes: due date and weight changes logged by syncs (decision #296); the handler lives in
// scripts/lib/course-changes-log.mjs.
import { createCourseChangesHandler } from '../../scripts/lib/course-changes-log.mjs';
import type { RouteContext, RouteHandler } from '../context.ts';

export function courseChangesRoute({ projectDir }: RouteContext): RouteHandler {
  const handle = createCourseChangesHandler(projectDir);
  return (req, res) => { void handle(req, res); };
}
