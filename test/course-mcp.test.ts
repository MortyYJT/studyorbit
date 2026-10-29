import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toDisplayDocument, type CourseDocument } from '../shared/course-data.js';
import { courseTools, runTool, toolDefinitions, type ToolContext } from '../shared/course-tools.js';
import { courseContextLoader, createCourseMcpServer, TOOL_ANNOTATIONS } from '../scripts/lib/course-mcp.mjs';
import { parseServerOptions } from '../scripts/mcp-server.mjs';

// Synthetic courses only; temporary directories stand in for the project and the Desktop.
type V2 = Extract<CourseDocument, { version: 2 }>;
type V2Item = V2['assessments'][number];
const item = (patch: Partial<V2Item> & { id: string; name: string }): V2Item => ({
  kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: null,
  status: 'unknown', scoring: 'none', rule: null, sources: [], refs: [], weightQuote: null, ruleQuote: null, unsourced: [], ...patch,
});
const doc = (id: string, code: string, assessments: V2Item[]): V2 => ({
  version: 2, course: { id, code, name: `Synthetic ${code}`, term: '2026 Semester 2' }, assessments, materials: [], legacyIds: {},
});
const first = doc('101', 'SYNT10001', [
  item({ id: 'a1', name: 'Assignment 1', weight: 30, score: 21, maxScore: 30, due: '2026-09-20T13:59:00Z', status: 'graded' }),
  item({ id: 'a2', name: 'Assignment 2', weight: 20, maxScore: 20, due: '2026-09-25T13:59:00Z', status: 'not_started' }),
  item({ id: 'exam', name: 'Final exam', kind: 'test', weight: 50, maxScore: 100, due: '2026-11-10', status: 'not_started' }),
]);
const second = doc('202', 'SYNT20002', [item({ id: 'b1', name: 'Essay', weight: 100, maxScore: 100, due: '2026-10-01', status: 'not_started' })]);
const context = (patch: Partial<ToolContext> = {}): ToolContext => ({
  documents: [toDisplayDocument(first), toDisplayDocument(second)],
  courses: [{ id: '101', code: 'SYNT10001', name: 'Synthetic SYNT10001' }, { id: '202', code: 'SYNT20002', name: 'Synthetic SYNT20002' }],
  scope: ['101', '202'], today: '2026-09-14', planning: null, ...patch,
});

/** Valid arguments for every tool, used to compare MCP text with the registry's. */
const validCalls: [string, Record<string, unknown>][] = [
  ['list_courses', {}],
  ['get_assessments', { courseId: '101' }],
  ['get_assessments', { courseId: '101', kind: 'test' }],
  ['calculate_grades', { courseId: '101', whatIf: [{ assessmentId: 'a2', percent: 75 }] }],
  ['final_needed', { courseId: '101', target: 'H1' }],
  ['upcoming_deadlines', { days: 30 }],
  ['plan_schedule', { tasks: [{ title: 'Draft essay', courseId: '202', courseCode: 'SYNT20002', due: '2026-09-18', minutes: 300 }] }],
  ['plan_schedule', {}],
];

type Text = { type: 'text'; text: string };
async function connect(loadContext: () => Promise<ToolContext> | ToolContext): Promise<Client> {
  const server = createCourseMcpServer({ loadContext, version: '0.0.0-test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Text[];
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  return { text: content[0].text, isError: result.isError === true };
}

describe('createCourseMcpServer', () => {
  it('lists every registry tool with its name, title, description, read-only annotations and schema properties', async () => {
    const client = await connect(() => context());
    expect(client.getServerVersion()?.name).toBe('studyorbit');
    const { tools } = await client.listTools();
    const definitions = toolDefinitions();
    expect(tools.map(tool => tool.name)).toEqual(courseTools.map(tool => tool.name));
    for (const tool of tools) {
      const definition = definitions.find(entry => entry.name === tool.name)!;
      expect(tool.title).toBe(definition.title);
      expect(tool.description).toBe(definition.description);
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(definition.parameters.properties).sort());
      expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([...(definition.parameters.required ?? [])].sort());
    }
    expect(TOOL_ANNOTATIONS).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('returns the registry text for valid arguments', async () => {
    const client = await connect(() => context());
    for (const [name, args] of validCalls) {
      const expected = runTool(name, args, context());
      const actual = await call(client, name, args);
      expect(actual.text, name).toBe(expected.text);
      expect(actual.isError, name).toBe(!expected.ok);
    }
  });

  it('marks registry errors with isError and keeps their text', async () => {
    const client = await connect(() => context({ scope: ['101'] }));
    const actual = await call(client, 'get_assessments', { courseId: '202' });
    expect(actual.isError).toBe(true);
    expect(actual.text).toBe(runTool('get_assessments', { courseId: '202' }, context({ scope: ['101'] })).text);
    expect(JSON.parse(actual.text).error.code).toBe('COURSE_NOT_IN_SCOPE');
  });

  it('answers schema-invalid arguments with isError and keeps serving', async () => {
    const client = await connect(() => context());
    expect((await call(client, 'final_needed', {})).isError).toBe(true);
    expect((await call(client, 'upcoming_deadlines', { days: 'soon' })).isError).toBe(true);
    expect((await call(client, 'list_courses', {})).isError).toBe(false);
  });

  it('loads the context on every call', async () => {
    let calls = 0;
    const client = await connect(() => { calls += 1; return context({ today: calls === 1 ? '2026-09-14' : '2026-09-15' }); });
    expect(JSON.parse((await call(client, 'list_courses', {})).text).today).toBe('2026-09-14');
    expect(JSON.parse((await call(client, 'list_courses', {})).text).today).toBe('2026-09-15');
    expect(calls).toBe(2);
  });

  it('turns a failing load into a tool error without file paths', async () => {
    let fail = true;
    const client = await connect(async () => {
      if (fail) throw new Error("ENOENT: no such file or directory, open '/synthetic/project/.local/lms/courses.json'");
      return context();
    });
    const failed = await call(client, 'list_courses', {});
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.text).error.code).toBe('COURSES_UNAVAILABLE');
    expect(failed.text).not.toContain('/synthetic');
    fail = false;
    expect((await call(client, 'list_courses', {})).isError).toBe(false);
  });
});

let root: string, project: string, desktop: string;
const folder = (code: string) => join(desktop, '墨尔本大学 2026 S2', code);
async function writeCourseFile(code: string, name: string, data: unknown, minute: number) {
  await mkdir(folder(code), { recursive: true });
  const path = join(folder(code), name);
  await writeFile(path, JSON.stringify(data));
  const time = new Date(Date.UTC(2026, 9, 1, 0, minute));
  await utimes(path, time, time);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studyorbit-mcp-'));
  project = join(root, 'project');
  desktop = join(root, 'Desktop');
  await mkdir(join(project, '.local', 'lms'), { recursive: true });
  await writeFile(join(project, '.local', 'lms', 'courses.json'), JSON.stringify({ courses: [
    { id: '101', name: 'Synthetic SYNT10001', code: 'SYNT10001_2026_SM2', term: '2026 Semester 2' },
    { id: '202', name: 'Synthetic SYNT20002', code: 'SYNT20002_2026_SM2', term: '2026 Semester 2' },
  ] }));
  await writeCourseFile('SYNT10001', '分数结构.json', first, 0);
  await writeCourseFile('SYNT20002', '分数结构.json', second, 0);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('courseContextLoader', () => {
  const now = () => new Date('2026-09-14T15:30:00Z'); // 2026-09-15 01:30 in Melbourne

  it('reads the course list and Desktop documents with every listed course in scope and Melbourne today', async () => {
    const ctx = await courseContextLoader({ projectDir: project, desktop, now })();
    expect(ctx.scope).toEqual(['101', '202']);
    expect(ctx.today).toBe('2026-09-15');
    expect(ctx.planning).toBeNull();
    expect(ctx.courses).toEqual([{ id: '101', code: 'SYNT10001', name: 'Synthetic SYNT10001' }, { id: '202', code: 'SYNT20002', name: 'Synthetic SYNT20002' }]);
    expect(ctx.documents).toEqual([toDisplayDocument(first), toDisplayDocument(second)]);
  });

  it('limits the scope to the course filter', async () => {
    const client = await connect(courseContextLoader({ projectDir: project, desktop, courseIds: ['101'], now }));
    expect(JSON.parse((await call(client, 'list_courses', {})).text).courses.map((course: { id: string }) => course.id)).toEqual(['101']);
    const outside = await call(client, 'get_assessments', { courseId: '202' });
    expect(outside.isError).toBe(true);
    expect(JSON.parse(outside.text).error.code).toBe('COURSE_NOT_IN_SCOPE');
  });

  it('drops filter IDs that are not in the course list', async () => {
    const ctx = await courseContextLoader({ projectDir: project, desktop, courseIds: ['999', '202'], now })();
    expect(ctx.scope).toEqual(['202']);
  });

  it('uses a newer course document written while the server runs', async () => {
    const client = await connect(courseContextLoader({ projectDir: project, desktop, now }));
    expect(JSON.parse((await call(client, 'get_assessments', { courseId: '202' })).text).assessments).toHaveLength(1);
    const newer = doc('202', 'SYNT20002', [...second.assessments, item({ id: 'b2', name: 'Presentation', kind: 'presentation', weight: 0 })]);
    await writeCourseFile('SYNT20002', '分数结构-2.json', newer, 5);
    expect(JSON.parse((await call(client, 'get_assessments', { courseId: '202' })).text).assessments).toHaveLength(2);
  });

  it('rejects when the course list is missing', async () => {
    await rm(join(project, '.local'), { recursive: true });
    await expect(courseContextLoader({ projectDir: project, desktop, now })()).rejects.toThrow();
  });
});

describe('parseServerOptions', () => {
  it('reads --project, --desktop and --courses, with STUDYORBIT_COURSES as the fallback filter', () => {
    expect(parseServerOptions(['--project', 'p', '--desktop', 'd', '--courses', '101, 202,'], {})).toMatchObject({ desktop: expect.stringMatching(/d$/), courseIds: ['101', '202'] });
    expect(parseServerOptions([], { STUDYORBIT_COURSES: '303' }).courseIds).toEqual(['303']);
    expect(parseServerOptions(['--courses', '101'], { STUDYORBIT_COURSES: '303' }).courseIds).toEqual(['101']);
    expect(parseServerOptions([], {}).courseIds).toBeNull();
    expect(parseServerOptions([], { STUDYORBIT_COURSES: ' ' }).courseIds).toBeNull();
    expect(parseServerOptions([], {}).desktop).toBeUndefined();
  });

  it('defaults the project to the repository containing the script', () => {
    expect(parseServerOptions([], {}).projectDir).toBe(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''));
  });

  it('rejects unknown options and missing values', () => {
    expect(() => parseServerOptions(['--port', '1'], {})).toThrow();
    expect(() => parseServerOptions(['--project'], {})).toThrow();
  });
});

/** Every file below `dir` with its size and modification time. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    out[path] = entry.isDirectory() ? 'dir' : `${info.size}:${info.mtimeMs}`;
  }
  return out;
}

describe('scripts/mcp-server.mjs over stdio', () => {
  it('serves the tools from the given directories with the env filter and writes no file', async () => {
    const before = { project: await snapshot(project), desktop: await snapshot(desktop) };
    const script = fileURLToPath(new URL('../scripts/mcp-server.mjs', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [script, '--project', project, '--desktop', desktop],
      env: { ...getDefaultEnvironment(), STUDYORBIT_COURSES: '101' }, stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('studyorbit');
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toEqual(courseTools.map(tool => tool.name));
      const listed = await call(client, 'list_courses', {});
      expect(JSON.parse(listed.text).courses.map((course: { id: string }) => course.id)).toEqual(['101']);
      for (const [name, args] of validCalls) await call(client, name, args);
      expect((await call(client, 'final_needed', {})).isError).toBe(true);
      expect((await call(client, 'list_courses', {})).isError).toBe(false);
    } finally {
      await client.close();
    }
    expect(await snapshot(project)).toEqual(before.project);
    expect(await snapshot(desktop)).toEqual(before.desktop);
    expect(stderr).toContain('studyorbit');
  }, 20_000);
});
