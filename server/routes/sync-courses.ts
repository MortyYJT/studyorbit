// /api/local/sync-courses: course discovery. POST runs the Canvas source's discovery collector (in the owner's
// signed-in browser) into .local/lms/courses.json; DELETE cancels it. `Origin` is required on every method.
import { execFile, spawn, type ChildProcess, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { courseFile, type RouteContext, type RouteHandler } from '../context.ts';

export type CourseDiscovery = { route: RouteHandler; cancel(): void; running(): boolean };
/**
 * The discovery process for an output path: an absolute script, its arguments and the environment it adds. Built once
 * per discovery from the source settings read then.
 */
export type DiscoveryCommand = (out: string) => Promise<{ script: string; args: string[]; env: Record<string, string> }>;

/** `command` builds the discovery process (the Canvas source's); tests swap in a stub script. */
export function syncCoursesRoute({ projectDir }: RouteContext, command: DiscoveryCommand): CourseDiscovery {
  let syncRunning = false;
  let discoveryProcess: ChildProcess | undefined;
  let discoveryCancelled = false;
  const cancel = () => {
    discoveryCancelled = true;
    const child = discoveryProcess;
    if (!child?.pid) return;
    if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']); return; }
    // execFile does not pass `detached` on to spawn, so the child has no process group of its own and the group
    // kill fails with ESRCH; stop the child itself then (before the move this left discovery running until done).
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  };
  const route: RouteHandler = async (req, res) => {
    const origin = req.headers.origin;
    if (!origin || origin !== `http://${req.headers.host}`) { res.writeHead(403).end(); return; }
    if (req.method === 'DELETE') {
      cancel();
      res.writeHead(200).end(JSON.stringify({ ok: true })); return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (syncRunning) { res.writeHead(409).end(); return; }
    syncRunning = true;
    discoveryCancelled = false;
    let discovery;
    try { discovery = await command(courseFile(projectDir)); } catch (error) {
      syncRunning = false;
      const code = error instanceof Error && error.name === 'SourceSettingsError' ? 'SOURCE_SETTINGS_UNREADABLE' : 'DISCOVERY_UNAVAILABLE';
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: code }));
      return;
    }
    if (discoveryCancelled) {
      syncRunning = false;
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: 'SYNC_CANCELLED' }));
      return;
    }
    discoveryProcess = execFile(process.execPath, [discovery.script, ...discovery.args], { cwd: projectDir, env: { ...process.env, ...discovery.env }, timeout: 45000, maxBuffer: 1024 * 1024, detached: process.platform !== 'win32' } as ExecFileOptionsWithStringEncoding, (error, _stdout, stderr) => {
      syncRunning = false;
      discoveryProcess = undefined;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (discoveryCancelled) { res.writeHead(409).end(JSON.stringify({ error: 'SYNC_CANCELLED' })); return; }
      if (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: stderr.trim().slice(0, 2000) || '获取课程失败。' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, ...(stderr.trim() ? { warning: stderr.trim().slice(0, 1000) } : {}) }));
    });
  };
  return { route, cancel, running: () => syncRunning };
}
