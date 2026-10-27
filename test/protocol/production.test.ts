import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { parseProtocolCLI } from '../../src/protocol/cli.js';
import { synthetic } from '../fixtures/synthetic.js';
import { fakeCodex, fixture } from '../agent/fake-codex.js';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({ ...await importOriginal<object>(), query }));
const roots: string[] = []; const closes: (() => void)[] = [];
afterEach(async () => { closes.splice(0).forEach(close => close()); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'protocol-production-'))); roots.push(home); vi.stubEnv('COURSEWORK_HOME', home);
  const host = createProductionProtocol({ owner: { assertOwner: async () => {} } }); closes.push(host.close);
  host.store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
  return host;
}
it('omits unresolved name/answer-like IDs from durable autonomy audit', async () => {
  const host = await setup(); const assessmentId = 'Synthetic.Person/answer-is-42';
  expect(await dispatch(host.registry, 'autonomy.check', { assessmentId, action: 'fill' }, host.context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'assessment-unavailable' } });
  const raw = await readFile(join(process.env.COURSEWORK_HOME!, 'quiz', 'audit.jsonl'), 'utf8');
  expect(raw).not.toContain(assessmentId);
  const events = (await host.audit.list()).filter(event => event.command === 'autonomy.check');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ level: 0, decision: 'denied', code: 'INVALID_INPUT' });
  expect(events[0]).not.toHaveProperty('assessmentId');
});
it('production CLI reads real SQLite, uses private journals and survives reopen', async () => {
  const host = await setup(); const stdout: string[] = [];
  await parseProtocolCLI(['courses', 'list', '--json'], { ...host, stdout: value => stdout.push(value) });
  expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, data: { items: [synthetic.course] } });
  expect(await host.audit.list()).toHaveLength(2);
  host.close(); const next = createProductionProtocol(); closes.push(next.close);
  expect(await dispatch(next.registry, 'courses.list', {}, next.context)).toMatchObject({ ok: true, data: { items: [synthetic.course] } });
});
it('new owner settings survive reopen and legacy L4 grants remain unread and unchanged', async () => {
  const host = await setup();
  const call = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const policy = { version: 1, courseId: synthetic.course.id, status: 'owner-attested', attestation: 'Synthetic only', date: '2026-10-14', cap: 4 };
  const grant = { version: 1, courseId: synthetic.course.id, assessmentId: 'd', category: 'assignment', level: 4, date: '2026-10-14' };
  expect(await call('policy.record', policy)).toMatchObject({ ok: true });
  expect(await call('grant.record', grant)).toMatchObject({ ok: true });
  expect(await call('autonomy.check', { assessmentId: 'd', action: 'fill' })).toMatchObject({ data: { decision: 'denied', reason: 'grant-level' } });
  await call('autonomy.default.set', { courseId: synthetic.course.id, level: 2 });
  await call('autonomy.override.set', { assessmentId: 'd', level: 0 });
  host.close();
  const next = createProductionProtocol({ owner: { assertOwner: async () => {} } }); closes.push(next.close);
  expect(next.store.readCourseAutonomy(synthetic.course.id).at(-1)).toMatchObject({ defaultLevel: 2 });
  expect(await dispatch(next.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, next.context)).toMatchObject({ data: { decision: 'denied' } });
  await dispatch(next.registry, 'autonomy.override.clear', { assessmentId: 'd' }, next.context);
  expect(await dispatch(next.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, next.context)).toMatchObject({ data: { decision: 'allowed' } });
  const { ProtocolFiles } = await import('../../src/protocol/files.js');
  const { hash } = await import('../../src/citations/exact.js');
  expect(await new ProtocolFiles().read(`protocol-grant-${hash('d')}`)).toEqual(grant);
});
it('non-TTY CLI refuses both owner writes in one envelope without storing records', async () => {
  const host = await setup();
  for (const name of ['policy', 'grant']) {
    const stdout: string[] = [];
    const input = name === 'policy' ? ['--version', '1', '--course-id', synthetic.course.id, '--status', 'owner-attested', '--attestation', 'Synthetic', '--date', '2026-10-14', '--cap', '4']
      : ['--version', '1', '--course-id', synthetic.course.id, '--assessment-id', 'd', '--category', 'assignment', '--level', '4', '--date', '2026-10-14'];
    await parseProtocolCLI([name, 'record', ...input], { ...host, isTTY: false, stdout: s => stdout.push(s), stderr: () => {} });
    expect(stdout).toHaveLength(1); expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }
  expect(await dispatch(host.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, host.context)).toMatchObject({ ok: true, data: { reason: 'grant-level' } });
});
it('shared production file writer failure yields denied audit-unavailable', async () => {
  const host = await setup();
  const { ProtocolFiles } = await import('../../src/protocol/files.js');
  const { CourseworkError } = await import('../../src/protocol/errors.js');
  class BrokenFiles extends ProtocolFiles {
    override async append(): Promise<void> { throw new CourseworkError('INTERNAL', 'Synthetic writer outage'); }
  }
  const broken = createProductionProtocol({ store: host.store, files: new BrokenFiles(process.env.COURSEWORK_HOME) }); closes.push(broken.close);
  expect(await dispatch(broken.registry, 'autonomy.check', { assessmentId: 'd', action: 'fill' }, broken.context))
    .toMatchObject({ ok: true, data: { decision: 'denied', reason: 'audit-unavailable' } });
});

it('production chat uses the Codex adapter by default without calling the Claude SDK', async () => {
  const fake = fakeCodex([{ fixture: fixture('codex-exec.jsonl') }]); closes.push(fake.cleanup);
  const host = await setup(); const owner = { assertOwner: async () => {} };
  const conversation = await host.chat.create({}, owner);
  expect(conversation.adapter).toBe('codex');
  await host.chat.send(conversation.id, 'Synthetic prompt', owner); await host.chat.waitForIdle(conversation.id);
  expect(fake.calls()).toHaveLength(1);
  expect(host.chat.open(conversation.id).conversation.sessionRef).toBe('t-1');
  expect(query).not.toHaveBeenCalled();
});

it('Claude on request: COURSEWORK_AGENT=claude uses the Claude SDK, never starts codex, and keeps explicit adapter overrides', async () => {
  const fake = fakeCodex([{ fixture: fixture('codex-exec.jsonl') }]); closes.push(fake.cleanup);
  vi.stubEnv('COURSEWORK_AGENT', 'claude');
  query.mockImplementation(() => Object.assign((async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic reply' }] } };
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01, session_id: 'synthetic-session' };
  })(), { interrupt: vi.fn() }));
  const host = await setup(); const owner = { assertOwner: async () => {} };
  const conversation = await host.chat.create({}, owner);
  expect(conversation.adapter).toBe('claude');
  const { messageId } = await host.chat.send(conversation.id, 'Synthetic prompt', owner);
  await host.chat.waitForIdle(conversation.id);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]![0]).toMatchObject({ prompt: expect.stringMatching(/Background from the coursework store[\s\S]*Synthetic prompt$/), options: { cwd: join(process.env.COURSEWORK_HOME!, 'agent-workspace') } });
  expect(host.chat.open(conversation.id).messages[1]!.parts).toEqual([{ type: 'text', text: 'Synthetic reply' }]);
  expect(host.store.loadRun(messageId)).toMatchObject({ turns: 1, costUsd: 0.01, outcome: 'ok' });
  const { unavailableAdapter } = await import('../../src/agent/adapter.js');
  const overridden = createProductionProtocol({ store: host.store, agentAdapter: unavailableAdapter });
  const other = await overridden.chat.create({}, owner);
  await overridden.chat.send(other.id, 'No SDK call', owner); await overridden.chat.waitForIdle(other.id);
  expect(overridden.chat.events(other.id).at(-1)!.event).toMatchObject({ type: 'error', code: 'AGENT_UNAVAILABLE' });
  expect(query).toHaveBeenCalledOnce();
  expect(fake.calls()).toHaveLength(0);
});

it('gives production chat the agent tool set and the live UI port', async () => {
  const { writeFile } = await import('node:fs/promises');
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const call = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: command, cwd: options.cwd }, command, {});
    for (const command of ['curl http://127.0.0.1:4568/api/status']) {
      expect((await call(command)).hookSpecificOutput.permissionDecision).toBe('deny');
    }
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'synthetic', version: '1' });
    await options.mcpServers.coursework.instance.connect(serverTransport); await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['courses.list', 'source.record']));
    expect(names).not.toContain('grant.record'); expect(names).not.toContain('sync.run');
    const listed = await client.callTool({ name: 'courses.list', arguments: {} });
    expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toMatchObject({ ok: true });
    await client.close();
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'synthetic-session' };
  })(), { interrupt: vi.fn() }));
  vi.stubEnv('COURSEWORK_AGENT', 'claude');
  const host = await setup(); const owner = { assertOwner: async () => {} };
  host.agentRuntime.frontendOrigin = 'http://127.0.0.1:4568';
  const conversation = await host.chat.create({}, owner);
  const { messageId } = await host.chat.send(conversation.id, 'Synthetic prompt', owner);
  await host.chat.waitForIdle(conversation.id);
  expect(host.store.loadRun(messageId)).toMatchObject({ outcome: 'ok', steps: 1 });
});

it('keeps the UI origin denial when a leftover browser.json is unreadable', async () => {
  const { writeFile } = await import('node:fs/promises');
  query.mockImplementation(({ options }) => Object.assign((async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    const command = 'curl http://127.0.0.1:4569/api/status';
    expect((await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'ui', cwd: options.cwd }, 'ui', {}))
      .hookSpecificOutput.permissionDecision).toBe('deny');
    yield { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'synthetic-session' };
  })(), { interrupt: vi.fn() }));
  vi.stubEnv('COURSEWORK_AGENT', 'claude');
  const host = await setup(); const owner = { assertOwner: async () => {} };
  await writeFile(join(process.env.COURSEWORK_HOME!, 'browser.json'), '{ corrupted');
  host.agentRuntime.frontendOrigin = 'http://127.0.0.1:4569';
  const conversation = await host.chat.create({}, owner);
  const { messageId } = await host.chat.send(conversation.id, 'Synthetic prompt', owner);
  await host.chat.waitForIdle(conversation.id);
  expect(host.store.loadRun(messageId)).toMatchObject({ outcome: 'ok', steps: 1 });
});

it('runs one selected course through the layered pipeline, merges dated Ed lessons and archives its reported files', async () => {
  const { mkdir, utimes, writeFile } = await import('node:fs/promises');
  const { assessmentId } = await import('../../src/sync/course-import.js');
  type EdCommandResult = { code: number; stdout: string };
  type EdRunner = (args: string[]) => Promise<EdCommandResult>;
  type AgentAdapter = import('../../src/agent/adapter.js').AgentAdapter;
  type AgentInput = import('../../src/agent/adapter.js').AgentInput;
  type AgentRun = import('../../src/agent/adapter.js').AgentRun;
  type AgentEvent = import('../../src/agent/adapter.js').AgentEvent;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'production-pipeline-')));
  roots.push(root);
  const home = join(root, 'home');
  const downloads = join(home, 'Downloads');
  await mkdir(downloads, { recursive: true });
  vi.stubEnv('COURSEWORK_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('COURSEWORK_FILES', join(root, 'Desktop'));
  const key = 'SYNA10001:2026:S2';
  const canvasPage = 'https://canvas.lms.unimelb.edu.au/courses/1';
  const edPage = 'https://edstem.org/au/courses/8001';
  const clipboard = { text: '', read(): string { return clipboard.text; } };
  const ok = (stdout: string): EdCommandResult => ({ code: 0, stdout });
  const edRunner: EdRunner = async args => {
    if (args[0] === '--version') return ok('0.8.2');
    if (args[0] === 'auth') return ok('{"authenticated":true}');
    if (args[0] === 'units') return ok(JSON.stringify([{ id: 4101, code: 'SYNA10001 S2 2026', year: '2026', session: 'Semester 2' }]));
    if (args[0] === 'lessons') return ok(JSON.stringify([
      { id: 7001, courseId: 8001, title: 'Synthetic Ed lesson', moduleName: 'Synthetic module', dueAt: '2026-10-30T12:59:00Z' },
      { id: 7002, courseId: 8001, title: 'Synthetic undated lesson', moduleName: 'Synthetic module', dueAt: null },
    ]));
    if (args[0] === 'files') return ok('[]');
    return { code: 1, stdout: '' };
  };
  const adapter: AgentAdapter = {
    id: 'synthetic',
    start(input: AgentInput): AgentRun {
      const jobId = /Job id: (\S+)/.exec(input.prompt)![1]!;
      const courseKey = /Course key: (\S+)/.exec(input.prompt)?.[1];
      const tool = (name: string) => input.tools.find(entry => entry.name === name);
      const call = async (name: string, args: unknown) => {
        const found = tool(name);
        if (!found) throw new Error(`missing synthetic tool ${name}`);
        const envelope = await found.execute(args) as { ok: boolean; error?: { message: string } };
        if (!envelope.ok) throw new Error(envelope.error?.message ?? name);
        return envelope;
      };
      const events = (async function* (): AsyncGenerator<AgentEvent, void> {
        if (tool('courses.offer')) {
          clipboard.text = JSON.stringify([{ id: 1, name: 'Synthetic Systems', course_code: 'SYNA10001_2026_SM2', term: { name: 'Semester 2 2026' } }]);
          await call('canvas.capture', { jobId, page: 'courses' });
        } else if (tool('handbook.capture')) {
          clipboard.text = ['The University of Melbourne Handbook', 'SYNA10001 Synthetic Systems', 'Assessment',
            'Description\tTiming\tPercentage', 'Assignments\tWeeks 3-10\t30%', 'Exam\tExam period\t70%'].join('\n');
          await call('handbook.capture', { jobId, courseKey });
        } else if (tool('course.map')) {
          await call('course.map', { jobId, courseKey, lms: { text: 'Synthetic LMS', quote: 'Synthetic LMS quote' },
            ed: { text: 'Synthetic Ed', quote: 'Synthetic Ed quote' }, syllabus: { where: 'unknown' }, links: [] });
        } else if (tool('quizzes.read')) {
          await call('quizzes.read', { jobId, courseKey, quizzes: [] });
        } else if (tool('assignment.saved')) {
          await call('assignment.saved', { jobId, courseKey, assignmentId: /Assignment id: (\S+)/.exec(input.prompt)![1]!,
            policy: { value: 'allowed', quote: 'Synthetic AI statement' }, files: ['synthetic-brief.mhtml'] });
        } else if (tool('materials.saved')) {
          await call('materials.saved', { jobId, courseKey, files: ['synthetic-week1.pdf'], links: [] });
        } else if (tool('ed.read')) {
          await call('ed.read', { jobId, courseKey, lessons: [] });
        } else if (tool('items.classify')) {
          await call('items.classify', { jobId, courseKey, items: [{ id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }] });
        } else if (tool('canvas.capture')) {
          const page = input.prompt.includes('page `tabs`') ? 'tabs' : 'groups';
          clipboard.text = page === 'tabs' ? JSON.stringify([
            { id: 'home', label: 'Home', type: 'internal', html_url: canvasPage },
            { id: 'assignments', label: 'Assignments', type: 'internal', html_url: `${canvasPage}/assignments` },
            { id: 'quizzes', label: 'Quizzes', type: 'internal', html_url: `${canvasPage}/quizzes` },
            { id: 'grades', label: 'Grades', type: 'internal', html_url: `${canvasPage}/grades` },
            { id: 'modules', label: 'Modules', type: 'internal', html_url: `${canvasPage}/modules` },
          ]) : JSON.stringify([{ id: 501, name: 'Assignments', group_weight: 40, assignments: [{
            id: 1, name: 'Synthetic Assignment 1', course_id: 1, due_at: '2026-10-31T12:59:00Z', unlock_at: '2026-10-01T00:00:00Z',
            points_possible: 20, assignment_group_id: 501, html_url: `${canvasPage}/assignments/1`,
            updated_at: '2026-10-20T08:00:00Z', submission: null,
          }] }]);
          await call('canvas.capture', { jobId, courseKey, page });
        }
        yield { type: 'tool_step', tool: 'coursework.synthetic', outcome: 'ok' };
        yield { type: 'result', turns: 1 };
      })();
      return { [Symbol.asyncIterator]: () => events, interrupt() {} };
    },
  };
  const extensionRead = vi.fn(async (url: string) => ({ status: 200, finalUrl: url, text: JSON.stringify([
    { id: 1, course_code: 'SYNA10001', name: 'Synthetic Systems', term: { name: 'Semester 2 2026' } },
  ]) }));
  const host = createProductionProtocol({ extension: { read: extensionRead }, agentAdapter: adapter, clipboard, edRunner, owner: { assertOwner: async () => {} } });
  closes.push(host.close);
  host.store.saveCourseSelections([{ key, code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2',
    pages: { canvas: canvasPage, ed: edPage }, offeredAt: '2026-10-24T00:00:00Z', selected: true }]);
  const future = new Date(Date.now() + 60_000);
  await writeFile(join(downloads, 'synthetic-brief.mhtml'), 'Synthetic assignment page');
  await writeFile(join(downloads, 'synthetic-week1.pdf'), 'Synthetic slides');
  await utimes(join(downloads, 'synthetic-brief.mhtml'), future, future);
  await utimes(join(downloads, 'synthetic-week1.pdf'), future, future);

  const result = await dispatch(host.registry, 'sync.run', {}, host.context);
  expect(extensionRead).toHaveBeenCalledExactlyOnceWith('https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=100');
  expect(result).toMatchObject({ ok: true, data: { outcome: 'OK', run: { syncOutcome: 'OK', jobs: expect.arrayContaining([expect.objectContaining({ kind: 'courses', via: 'extension', outcome: 'ok' })]) } } });
  const run = (result as unknown as { data: { run: { id: string } } }).data.run;
  const course = host.store.query('courses', { limit: 10 }).items[0] as { id: string };
  expect(host.store.loadCourse(course.id)).toMatchObject({ code: 'SYNA10001', name: 'Synthetic Systems' });
  expect(host.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))).toMatchObject({ name: 'Synthetic Assignment 1', weight: 40 });
  expect(host.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:ed:lesson:7001'))).toMatchObject({ name: 'Synthetic Ed lesson', due: '2026-10-30T12:59:00Z',
    // Unclassified Ed lessons carry no marks: they must not hide the weight-sum check, block the grade projection or become plannable work.
    kind: 'ungraded', weight: 0 });
  expect((host.store.query('assessments', { limit: 50 }).items as { courseId: string; weight?: number; kind: string }[])
    .filter(item => item.kind !== 'ungraded' && item.weight === undefined)).toEqual([]);
  expect(host.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:ed:lesson:7002'))).toBeUndefined();
  expect(host.store.listSyncConflicts(course.id)).toEqual([expect.objectContaining({ field: 'weight', state: 'open', skeletonValue: 30, canvasValue: 40 })]);
  const folder = join(root, 'Desktop', 'UniMelb 26S2', 'Synthetic Systems');
  expect(await readFile(join(folder, 'assessments', 'Synthetic Assignment 1', 'synthetic-brief.mhtml'), 'utf8')).toContain('Synthetic assignment page');
  expect(await readFile(join(folder, 'materials', 'synthetic-week1.pdf'), 'utf8')).toContain('Synthetic slides');
  expect(host.store.listSyncJobs().find(job => job.id === run.id)?.stages?.[key]?.archive)
    .toEqual({ moved: 2, updated: 0, missing: 0, unresolved: 0 });
});
