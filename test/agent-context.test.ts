import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_CONTEXT_LIMIT, FOCUS_MAX_AGE_MS, parseAgentContext, readAgentContext, writeAgentContext } from '../scripts/lib/agent-context.mjs';
import { runTool, type ToolContext } from '../shared/course-tools.js';

// The page context handed to the MCP server through `.local/agent-context.json` (decision #546). Synthetic data only.
const planning = { tasks: [{ key: 't1', title: 'Draft', courseId: '101', courseCode: 'SYNT10001', due: '2026-09-18', minutes: 180 }], availability: [120, 120, 120, 120, 120, 120, 120], targets: {} };
let project: string;
beforeEach(async () => { project = await mkdtemp(join(tmpdir(), 'so-agent-context-')); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

describe('parseAgentContext', () => {
  it('accepts a full context and a context without planning or focus', () => {
    expect(parseAgentContext({ selectedCourseIds: ['101'], focusCourseId: '101', planning })).toEqual({ ok: true, context: { selectedCourseIds: ['101'], focusCourseId: '101', planning } });
    expect(parseAgentContext({ selectedCourseIds: [] })).toEqual({ ok: true, context: { selectedCourseIds: [], focusCourseId: null, planning: null } });
  });
  it('refuses unknown fields, an invalid snapshot, bad ids and a client-chosen save time', () => {
    expect(parseAgentContext({ selectedCourseIds: ['101'], extra: 1 }).ok).toBe(false);
    expect(parseAgentContext({ selectedCourseIds: ['101'], planning: { ...planning, availability: [1] } }).ok).toBe(false);
    expect(parseAgentContext({ selectedCourseIds: ['../x'] }).ok).toBe(false);
    expect(parseAgentContext({ selectedCourseIds: ['101'], savedAt: '2026-01-01T00:00:00Z' }).ok).toBe(false);
    expect(parseAgentContext(null).ok).toBe(false);
  });
});

describe('agent context file', () => {
  it('is written atomically with owner-only permissions and stamped by the server', async () => {
    const saved = await writeAgentContext(project, { selectedCourseIds: ['101'], focusCourseId: '101', planning }, () => new Date('2026-09-14T01:00:00Z'));
    expect(saved.savedAt).toBe('2026-09-14T01:00:00.000Z');
    const file = join(project, '.local', 'agent-context.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(saved);
    expect(await readAgentContext(project)).toEqual(saved);
  });
  it('reads a missing, broken or oversized file as no context', async () => {
    expect(await readAgentContext(project)).toBeNull();
    await mkdir(join(project, '.local'), { recursive: true });
    await writeFile(join(project, '.local', 'agent-context.json'), '{"selectedCourseIds":');
    expect(await readAgentContext(project)).toBeNull();
    await writeFile(join(project, '.local', 'agent-context.json'), JSON.stringify({ savedAt: 'x', selectedCourseIds: ['101'], focusCourseId: null, planning: null }));
    expect(await readAgentContext(project)).toBeNull();
    await writeFile(join(project, '.local', 'agent-context.json'), ' '.repeat(AGENT_CONTEXT_LIMIT + 1));
    expect(await readAgentContext(project)).toBeNull();
  });
  it('refuses a context whose stored form would be too large to read back', async () => {
    const tasks = Array.from({ length: 400 }, (_, index) => ({ key: `k${index}-${'x'.repeat(480)}`, title: 't', courseId: '101', courseCode: 'SYNT10001', due: '2026-09-18', minutes: 30 }));
    const big = { selectedCourseIds: ['101'], focusCourseId: null, planning: { ...planning, tasks } };
    expect(JSON.stringify(big).length).toBeGreaterThan(AGENT_CONTEXT_LIMIT);
    await expect(writeAgentContext(project, big)).rejects.toThrow('TOO_LARGE');
    expect(await readAgentContext(project)).toBeNull();
    // Whatever is written can be read back, right up to the limit.
    const fitting = { ...big, planning: { ...planning, tasks: tasks.slice(0, 300) } };
    const saved = await writeAgentContext(project, fitting);
    expect(await readAgentContext(project)).toEqual(saved);
  });
  it('exports a 30-minute focus window', () => { expect(FOCUS_MAX_AGE_MS).toBe(30 * 60 * 1000); });
});

describe('tools with page context', () => {
  const ctx = (patch: Partial<ToolContext> = {}): ToolContext => ({ documents: [], courses: [{ id: '101', code: 'SYNT10001', name: 'Synthetic' }, { id: '202', code: 'SYNT20002', name: 'Synthetic 2' }], scope: ['101', '202'], today: '2026-09-14', planning: null, ...patch });
  it('plan_schedule reports when the snapshot was saved', () => {
    const value = runTool('plan_schedule', {}, ctx({ planning, planningSavedAt: '2026-09-14T01:00:00.000Z' })).value as Record<string, unknown>;
    expect(value).toMatchObject({ available: true, tasksSource: 'snapshot', snapshotSavedAt: '2026-09-14T01:00:00.000Z' });
    expect(runTool('plan_schedule', {}, ctx({ planning })).value).not.toHaveProperty('snapshotSavedAt');
    const fromArgument = runTool('plan_schedule', { tasks: [{ title: 'x', courseId: '101', courseCode: 'SYNT10001', due: '2026-09-18', minutes: 30 }] }, ctx({ planning, planningSavedAt: '2026-09-14T01:00:00.000Z' })).value;
    expect(fromArgument).not.toHaveProperty('snapshotSavedAt');
  });
  it('list_courses names a focus course only when it is in scope', () => {
    expect((runTool('list_courses', {}, ctx({ focusCourseId: '202' })).value as any).focus).toEqual({ courseId: '202', code: 'SYNT20002' });
    expect(runTool('list_courses', {}, ctx({ focusCourseId: '999' })).value).not.toHaveProperty('focus');
    expect(runTool('list_courses', {}, ctx()).value).not.toHaveProperty('focus');
  });
});
