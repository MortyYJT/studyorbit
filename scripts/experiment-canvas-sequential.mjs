#!/usr/bin/env node
// One browser capture finishes before the next begins; stop on the first failure.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const courses = process.argv.slice(2);
if (!courses.length || courses.some(id => !/^\d+$/.test(id))) throw new Error('用法：node scripts/experiment-canvas-sequential.mjs <课程ID> [课程ID...]');
const script = fileURLToPath(new URL('./experiment-canvas-course.mjs', import.meta.url));
for (const [index, course] of courses.entries()) {
  console.log(`\n课程 ${index + 1}/${courses.length}：${course}`);
  const exit = await new Promise(resolve => {
    const proc = spawn(process.execPath, [script, course], { stdio: 'inherit' });
    proc.on('error', () => resolve(1)); proc.on('close', code => resolve(code ?? 1));
  });
  if (exit !== 0) { console.error('当前课程未完成，已停止后续采集。'); process.exitCode = 1; break; }
}
