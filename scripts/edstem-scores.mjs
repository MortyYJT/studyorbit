#!/usr/bin/env node
/** Experimental read-only Ed adapter: list only the signed-in user's final submissions. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const ids = process.argv.slice(2);
if (!ids.length || ids.length > 50 || ids.some(id => !/^\d+$/.test(id))) throw new Error('Usage: node scripts/edstem-scores.mjs <lesson-id> [lesson-id...]');
const auth = JSON.parse((await exec('edstem', ['auth', 'status', '--json'], { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout);
if (!auth.authenticated || !Number.isSafeInteger(auth.user?.id) || auth.region !== 'au') throw new Error('EdStem Australia authentication is unavailable');
let token = process.env.EDSTEM_TOKEN?.trim();
if (!token) {
  const text = (await readFile(join(homedir(), '.config', 'edstem-cli', 'token'), 'utf8')).trim();
  token = text.startsWith('{') ? JSON.parse(text).token : text;
}
if (typeof token !== 'string' || !token.trim()) throw new Error('EdStem token unavailable');
async function get(path) {
  const response = await fetch(`https://edstem.org/api/${path}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!response.ok) return { error: `HTTP ${response.status}` };
  try { return { data: await response.json() }; } catch { return { error: 'Invalid JSON' }; }
}
const results = [];
for (const id of ids) {
  const started = Date.now();
  try {
    const found = await get(`lessons/${id}/attempts/${auth.user.id}`);
    if (found.error) { results.push({ lessonId: id, status: 'unavailable', reason: found.error, durationMs: Date.now() - started }); continue; }
    const finalId = found.data?.final_id;
    const finalAttempt = found.data?.attempts?.find(item => item.id === finalId && item.user_id === auth.user.id && String(item.lesson_id) === id);
    if (!finalAttempt) { results.push({ lessonId: id, status: 'no_final_submission', durationMs: Date.now() - started }); continue; }
    const marked = await get(`lessons/${id}/marking_status?attempt=${encodeURIComponent(finalId)}`);
    if (marked.error) { results.push({ lessonId: id, status: 'unavailable', reason: marked.error, durationMs: Date.now() - started }); continue; }
    const body = marked.data;
    if (body?.attempt_result?.user_id !== auth.user.id) throw new Error('Unexpected owner in Ed result');
    const totals = Object.values(body.slide_totals ?? {});
    const validTotals = totals.length && totals.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const maximum = validTotals ? totals.reduce((sum, value) => sum + value, 0) : null;
    const score = body.attempt_result.mark;
    const unmarked = Array.isArray(body.lesson_markable_marking_status) && body.lesson_markable_marking_status.some(item => Array.isArray(item.unmarked_user_ids) && item.unmarked_user_ids.includes(auth.user.id));
    const graded = !unmarked && typeof score === 'number' && Number.isFinite(score) && maximum !== null && maximum > 0;
    results.push({ lessonId: id, status: graded ? 'graded' : 'not_available', score: graded ? score : null, maxScore: graded ? maximum : null,
      submittedAt: finalAttempt.submitted_at ?? null, durationMs: Date.now() - started });
  } catch { results.push({ lessonId: id, status: 'unavailable', reason: 'Request or response failed', durationMs: Date.now() - started }); }
}
console.log(JSON.stringify({ source: 'edstem', results }, null, 2));
