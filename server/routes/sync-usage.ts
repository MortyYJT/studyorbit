// GET /api/local/sync-usage: the course sync usage log (.local/lms/course-sync-usage.jsonl), newest first.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { filterSubjects } from '../../scripts/lib/course-list.mjs';
import { courseFile, type RouteContext, type RouteHandler } from '../context.ts';

export function syncUsageRoute({ projectDir }: RouteContext): RouteHandler {
  return async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const raw = await readFile(join(projectDir, '.local', 'lms', 'course-sync-usage.jsonl'), 'utf8');
      const items = raw.split('\n').filter(Boolean).slice(-1000).flatMap(line => {
        try {
          const row = JSON.parse(line);
          const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
          const usage = (value: any) => value && typeof value === 'object' ? { input: count(value.input), output: count(value.output), cached: count(value.cached), reasoning: count(value.reasoning) } : null;
          return [{ type: typeof row.type === 'string' ? row.type : 'course', runId: typeof row.runId === 'string' ? row.runId : '', at: typeof row.at === 'string' ? row.at : '', course: typeof row.course === 'string' ? row.course : '', courses: Array.isArray(row.courses) ? row.courses.flatMap((value: unknown) => typeof value === 'string' ? [{ code: value, status: '' }] : value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string' ? [{ code: (value as { code: string }).code, status: typeof (value as { status?: unknown }).status === 'string' ? (value as { status: string }).status : '' }] : []) : [], model: typeof row.model === 'string' ? row.model : '', status: typeof row.status === 'string' ? row.status : '', durationMs: count(row.durationMs), coordinator: usage(row.coordinator), subagents: usage(row.subagents), recovered: false }];
        } catch { return []; }
      });
      // Older logs lack run IDs. Recover only unique matches to a saved run/course directory's creation time.
      try {
        const input = JSON.parse(await readFile(courseFile(projectDir), 'utf8'));
        const courses: { id: string; code?: unknown }[] = (Array.isArray(input.courses) ? input.courses : []).filter((course: unknown): course is { id: string; code?: unknown } => !!course && typeof course === 'object' && typeof (course as { id?: unknown }).id === 'string');
        const candidates = filterSubjects(courses);
        const codes = new Map(candidates.map(course => [course.id, course.subjectCode]));
        const root = join(projectDir, '.local', 'lms', 'runs');
        const runs = await Promise.all((await readdir(root)).map(async runId => {
          try {
            const directory = join(root, runId);
            const ids = await readdir(directory);
            const courses = await Promise.all(ids.map(async id => {
              try { const info = await stat(join(directory, id)); return info.isDirectory() && codes.has(id) ? { code: codes.get(id) as string, birth: info.birthtimeMs } : null; }
              catch { return null; }
            }));
            return { runId, courses: courses.filter((value): value is { code: string; birth: number } => value !== null).sort((a, b) => a.birth - b.birth) };
          } catch { return { runId, courses: [] }; }
        }));
        for (const row of items) {
          if (row.runId || row.type !== 'course' || !row.course || !Number.isFinite(Date.parse(row.at))) continue;
          const matches = runs.filter(run => run.courses.some(course => course.code === row.course && Math.abs(course.birth - Date.parse(row.at)) <= 2));
          if (matches.length === 1) { row.runId = matches[0]!.runId; row.recovered = true; }
        }
        for (const run of runs) {
          const rows = items.filter(row => row.recovered && row.runId === run.runId);
          if (!rows.length) continue;
          const started = Math.min(...rows.map(row => Date.parse(row.at)));
          const complete = run.courses.length === rows.length && run.courses.every(course => rows.filter(row => row.course === course.code).length === 1) && rows.every(row => row.durationMs !== null);
          const elapsed = complete ? Math.max(...rows.map(row => Date.parse(row.at) + row.durationMs!)) - started : null;
          const courses = run.courses.map(course => ({ code: course.code, status: rows.find(row => row.course === course.code)?.status ?? '' }));
          items.push({ type: 'batch_end', runId: run.runId, at: new Date(started + (elapsed ?? 0)).toISOString(), course: '', courses, model: '', status: '', durationMs: elapsed, coordinator: null, subagents: null, recovered: true });
          items.push({ type: 'batch_start', runId: run.runId, at: new Date(started).toISOString(), course: '', courses, model: '', status: '', durationMs: null, coordinator: null, subagents: null, recovered: true });
        }
      } catch { /* Keep old records separate if run metadata cannot be verified. */ }
      items.reverse();
      res.end(JSON.stringify({ items }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') res.end(JSON.stringify({ items: [] }));
      else res.writeHead(500).end(JSON.stringify({ error: 'USAGE_UNAVAILABLE' }));
    }
  };
}
