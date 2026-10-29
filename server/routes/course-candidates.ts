// GET /api/local/course-candidates: the courses of `.local/lms/courses.json` filtered to subject candidates.
import { readFile } from 'node:fs/promises';
import { filterSubjects } from '../../scripts/lib/course-list.mjs';
import { courseFile, type RouteContext, type RouteHandler } from '../context.ts';

export function courseCandidatesRoute({ projectDir }: RouteContext): RouteHandler {
  return async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    try {
      const data = JSON.parse(await readFile(courseFile(projectDir), 'utf8'));
      if (!data || !Array.isArray(data.courses)) throw new Error('Invalid course file');
      const courses = filterSubjects(data.courses.filter((course: unknown) =>
        course && typeof course === 'object' && typeof (course as { id?: unknown }).id === 'string'
        && typeof (course as { name?: unknown }).name === 'string'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ courses, fetchedAt: data.fetchedAt, scope: data.scope }));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      res.writeHead(missing ? 404 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: missing ? 'COURSES_NOT_FOUND' : 'COURSES_UNAVAILABLE' }));
    }
  };
}
