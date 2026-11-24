// Page context handed to the MCP server (decision #546). Tasks, availability, target bands and the course selection
// live in the browser's localStorage, which the stdio MCP server cannot read. The page sends them, together with the
// course the owner is asking about, to `PUT /api/local/agent-context`; this module validates and stores them in
// `.local/agent-context.json` (mode 0600, atomic), and the MCP server reads the file on every tool call.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parsePlanningSnapshot } from '../../shared/planning-snapshot.ts';

/** Largest request body and file accepted, in bytes. */
export const AGENT_CONTEXT_LIMIT = 200000;
/** How long a course stays "in focus" after the page saved it. */
export const FOCUS_MAX_AGE_MS = 30 * 60 * 1000;

const courseId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const InputSchema = z.strictObject({
  selectedCourseIds: z.array(courseId).max(200),
  focusCourseId: courseId.nullable().optional(),
  planning: z.unknown().optional(),
});
const savedAt = z.string().refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);

const contextPath = projectDir => join(projectDir, '.local', 'agent-context.json');

/**
 * Strict check of what the page sends. The save time is never taken from the client. A missing snapshot means no
 * planning data; an invalid one refuses the whole context.
 * @param {unknown} value
 * @returns {{ ok: true, context: { selectedCourseIds: string[], focusCourseId: string | null, planning: import('../../shared/planning-snapshot.ts').SentPlanning | null } } | { ok: false }}
 */
export function parseAgentContext(value) {
  const parsed = InputSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  const planning = parsePlanningSnapshot(parsed.data.planning);
  if (!planning.ok) return { ok: false };
  return { ok: true, context: { selectedCourseIds: parsed.data.selectedCourseIds, focusCourseId: parsed.data.focusCourseId ?? null, planning: planning.planning } };
}

/**
 * Stores a context that `parseAgentContext` accepted, stamped with the server's clock.
 * @param {string} projectDir
 * @param {{ selectedCourseIds: string[], focusCourseId: string | null, planning: object | null }} context
 * @param {() => Date} [now]
 */
export async function writeAgentContext(projectDir, context, now = () => new Date()) {
  const saved = { savedAt: now().toISOString(), selectedCourseIds: context.selectedCourseIds, focusCourseId: context.focusCourseId, planning: context.planning };
  const file = contextPath(projectDir);
  await mkdir(join(projectDir, '.local'), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  return saved;
}

/**
 * The stored context, or null when the file is missing, too large or does not pass the same checks as the route
 * (the MCP server then behaves as it does without a page: every listed course in scope, no planning data).
 * @param {string} projectDir
 */
export async function readAgentContext(projectDir) {
  try {
    const file = contextPath(projectDir);
    if ((await stat(file)).size > AGENT_CONTEXT_LIMIT) return null;
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { savedAt: at, ...rest } = raw;
    if (!savedAt.safeParse(at).success) return null;
    const parsed = parseAgentContext(rest);
    return parsed.ok ? { savedAt: at, ...parsed.context } : null;
  } catch { return null; }
}
