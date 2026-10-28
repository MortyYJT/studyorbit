#!/usr/bin/env node
// Read-only experiment: extract lesson metadata; edstem keeps its own credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const run = promisify(execFile);
const unit = process.argv[2];
if (!unit || !/^\d+$/.test(unit)) throw new Error('Usage: node scripts/experiment-edstem.mjs <ed-course-id>');
const started = Date.now();
const { stdout } = await run('edstem', ['lessons', 'list', unit, '--json', '--module', 'all', '--state', 'all', '--status', 'all'], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
const data = JSON.parse(stdout);
if (!Array.isArray(data)) throw new Error('Unexpected Ed lesson response');
const lessons = data.filter(item => item && String(item.courseId) === unit).map(item => ({
  id: String(item.id), title: item.title, module: item.moduleName ?? null,
  due: item.dueAt ?? null, status: item.status ?? null,
  url: `https://edstem.org/au/courses/${unit}/lessons/${item.id}`,
}));
const result = { source: 'edstem-cli', courseId: unit, fetchedAt: new Date().toISOString(), durationMs: Date.now() - started, lessons };
const path = resolve('.local', 'experiments', `edstem-lessons-${unit}.json`);
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ courseId: unit, lessonCount: lessons.length, durationMs: result.durationMs, path }));
