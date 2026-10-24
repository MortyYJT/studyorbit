/**
 * Task 17.1: one synthetic walk through the v1 delivery flow on the production composition.
 * Every step shares one temporary COURSEWORK_HOME and one owner UI host bound to a real loopback socket.
 * Only the agent (course reading and chat) and the syllabus text are fakes; all data is invented.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { startOwnerUI } from '../../src/protocol/http-host.js';
import type { HttpTransport } from '../../src/protocol/http.js';
import { dispatch } from '../../src/protocol/registry.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { databasePath } from '../../src/config/data-dir.js';
import type { AgentAdapter, AgentEvent, AgentInput } from '../../src/agent/adapter.js';
import { hash } from '../../src/citations/exact.js';
import { SyntheticAdapter } from '../agent/synthetic.js';
import { component, document, found, item, quoted } from '../sync/course-document.js';

// Locally this file runs in about 2 s; sync and UI bootstrap get headroom on slow CI runners.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const quizName = 'Synthetic weekly quiz 1';
const quizUrl = 'https://canvas.lms.unimelb.edu.au/courses/1/quizzes/7';
// The quiz is due in two days; the term takes that date's Melbourne year so the document passes the term-year check.
const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
const term = `${new Intl.DateTimeFormat('en', { timeZone: 'Australia/Melbourne', year: 'numeric' }).format(new Date(due))}:S2`;
const pages = { canvas: 'https://canvas.lms.unimelb.edu.au/courses/1', ed: 'https://edstem.org/au/courses/9' };
const quizCourse = document([component('weekly-quizzes', 30, [item(7, { name: found(quizName), url: quizUrl, due: quoted(due, 'Due in two days', quizUrl) }, 'ABCD10001')],
  { name: found('Weekly quizzes'), kind: found('quiz') }, 'ABCD10001'), component('final-exam', 70, [], { kind: found('exam'), isFinal: found(true) }, 'ABCD10001')],
  { name: found('Synthetic Canvas'), pages, platforms: { canvas: 'read', ed: 'absent' } }, 'ABCD10001', term);
/** Synthetic course reading: offers the course while nothing is selected, then imports it through `course.import`. */
function readCourses(input: AgentInput): AsyncIterable<AgentEvent> {
  const jobId = /Job id: (\S+)/.exec(input.prompt)![1]!;
  const call = (name: string, args: unknown) => input.tools.find(tool => tool.name === name)!.execute(args) as Promise<{ ok: boolean }>;
  return (async function* () {
    const result = input.prompt.includes('Selected courses: none')
      ? await call('courses.offer', { jobId, courses: [{ code: 'ABCD10001', name: 'Synthetic Canvas', term, pages }], blocked: [] })
      : await call('course.import', { jobId, document: quizCourse });
    yield { type: 'tool_step', tool: 'coursework.sync', outcome: result.ok ? 'ok' : 'error' } as const;
    yield { type: 'result', turns: 3 } as const;
  })();
}

describe('v1 delivery end to end (synthetic)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coursework-e2e-')));
  const readings: AgentInput[] = [];
  const chatAgent = new SyntheticAdapter();
  // One adapter, as in production: reading jobs carry a job id, chat replies do not.
  const adapter: AgentAdapter = { id: 'synthetic', start: input => {
    if (!input.prompt.includes('Job id: ')) return chatAgent.start(input);
    readings.push(input);
    const events = readCourses(input);
    return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), interrupt() {} };
  } };
  let store: SqliteRepository; let host: ReturnType<typeof createProductionProtocol>; let transport: HttpTransport; let secret = '';
  const state = { courseId: '', assessmentId: '', annotationId: '', conversationId: '' };

  beforeAll(async () => {
    vi.stubEnv('COURSEWORK_HOME', root);
    const ui = join(root, 'ui'); mkdirSync(ui); writeFileSync(join(ui, 'index.html'), '<html>synthetic</html>');
    store = new SqliteRepository(databasePath());
    host = createProductionProtocol({ store, agentAdapter: adapter, owner: { assertOwner: async () => { throw new Error('No terminal owner in this test.'); } } });
    let opened = '';
    transport = await startOwnerUI(host, { staticDirectory: ui, capabilityDirectory: join(root, 'http'), opener: async url => { opened = url; } });
    secret = new URL(opened).hash.slice(3);
  });
  afterAll(async () => {
    await transport?.close(); await host?.close(); store?.close();
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  });

  /** One request as the UI sends it; `owner` adds the memory-only owner session header. */
  async function http(path: string, input?: unknown, owner = false) {
    const response = await fetch(`${transport.origin}${path}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(owner ? { 'X-Coursework-Session': secret } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() as any };
  }
  const api = (name: string, input: unknown = {}, owner = false) => http(`/api/${name}`, input, owner);
  // The external agent's MCP view: owner-free registry and context, same dispatcher.
  const agentCall = (name: string, input: unknown) => { const agent = host.registry.agentTools(host.context); return dispatch(agent.registry, name, input, agent.context); };

  it('1. reports no sync history before any sync and has no resident-browser command', async () => {
    expect(await api('sync.status')).toMatchObject({ status: 200, body: { ok: true, data: { running: false, blocked: [], undecided: 0, courses: [] } } });
    expect(await api('browser.status')).toMatchObject({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND' } } });
    expect(readings).toHaveLength(0);
  });

  it('2. owner sync offers the course, the owner selects it, and the next run stores the course and its quiz', async () => {
    expect((await api('sync.run')).status).toBe(403);
    expect(readings).toHaveLength(0);
    expect(await api('sync.run', {}, true)).toMatchObject({ status: 200, body: { ok: true, data: { outcome: 'NEEDS_SELECTION' } } });
    const candidates = (await api('courses.candidates')).body.data.items;
    expect(candidates).toEqual([expect.objectContaining({ key: `ABCD10001:${term}`, name: 'Synthetic Canvas' })]);
    // The agent's commands need credentials over HTTP; the selection needs the owner session.
    expect((await api('courses.offer', { jobId: 'any', courses: [], blocked: [] })).status).toBe(403);
    const selection = { selections: [{ key: candidates[0].key, selected: true }] };
    expect((await api('courses.select', selection)).status).toBe(403);
    expect(await api('courses.select', selection, true)).toMatchObject({ status: 200, body: { ok: true, data: { recorded: 1 } } });
    const run = await api('sync.run', {}, true);
    expect(run).toMatchObject({ status: 200, body: { ok: true, data: { outcome: 'OK', run: { syncOutcome: 'OK', courseCoverage: [expect.objectContaining({ stored: true })] } } } });
    expect(await api('sync.status')).toMatchObject({ body: { data: { lastRun: { id: run.body.data.run.id, outcome: 'OK' }, courses: [expect.objectContaining({ storedAt: expect.any(String) })] } } });
    const courses = (await api('courses.list')).body.data.items;
    expect(courses).toEqual([expect.objectContaining({ code: 'ABCD10001', name: 'Synthetic Canvas', sources: expect.arrayContaining([{ platform: 'canvas', externalId: '1' }]) })]);
    const assessments = (await api('assessments.list')).body.data.items;
    expect(assessments.find((a: { name: string }) => a.name === quizName)).toEqual(expect.objectContaining({ weight: 30, kind: 'quiz', group: expect.objectContaining({ name: 'Weekly quizzes' }),
      platform: expect.objectContaining({ linked: true, submitted: false }) }));
    state.courseId = courses[0].id; state.assessmentId = assessments.find((a: { name: string }) => a.name === quizName).id;
  });

  it('3. an agent annotation with a verified citation is confirmed by the owner over HTTP', async () => {
    // Imported items carry no page text; a fetched syllabus page is what an agent cites.
    const text = `${quizName} is a quiz worth 30% of the final mark.`;
    store.saveSourceItem({ id: 'syllabus-page', platform: 'canvas', externalId: 'page:syllabus', courseId: state.courseId, kind: 'announcement',
      title: 'Synthetic syllabus', text, contentHash: hash(text), fetchedAt: new Date().toISOString(), url: 'https://canvas.lms.unimelb.edu.au/courses/1/assignments/syllabus' });
    const sourceRevision = (await api('revision.read', { courseId: state.courseId })).body.data.sourceRevision;
    const recorded = await agentCall('annotation.record', { entity: 'assessment', entityId: state.assessmentId, field: 'kind', value: 'quiz', sourceRevision,
      citations: [{ sourceItemId: 'syllabus-page', quote: `${quizName} is a quiz`, locator: 'syllabus-page' }] });
    expect(recorded).toMatchObject({ ok: true, data: { citations: [expect.objectContaining({ sourceItemId: 'syllabus-page' })] } });
    state.annotationId = (recorded as { data: { id: string } }).data.id;
    const confirm = { entity: 'assessment', entityId: state.assessmentId, field: 'kind', annotationId: state.annotationId };
    expect((await api('annotation.confirm', confirm)).status).toBe(403);
    expect(await api('annotation.confirm', confirm, true)).toMatchObject({ status: 200, body: { ok: true } });
    const read = (await api('annotation.read', { entity: 'assessment', entityId: state.assessmentId })).body.data;
    expect(read.fields.kind).toMatchObject({ value: 'quiz', origin: 'agent', verdicts: [expect.objectContaining({ verdict: 'correct' })] });
    expect(read.history).toEqual(expect.arrayContaining([expect.objectContaining({ id: state.annotationId, origin: 'agent' })]));
  });

  it('4. planning settings and an agent estimate plan the quiz; the owner records actual time', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());
    const settings = { timeZone: 'Australia/Melbourne', weekdayMinutes: [120, 120, 120, 120, 120, 60, 60], teachingWeekAnchor: '2026-07-27', breakWeeks: [] };
    expect(await api('planning.settings.set', settings, true)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await agentCall('estimate.agent.set', { workId: state.assessmentId, minutes: 120, reason: 'Synthetic quiz of ten points.' })).toMatchObject({ ok: true });
    const plan = (await api('plan.read', { term, startDate: today, horizonDays: 7 })).body.data;
    expect(plan.days.flatMap((day: { items: { workId: string; minutes: number }[] }) => day.items))
      .toEqual(expect.arrayContaining([expect.objectContaining({ workId: state.assessmentId })]));
    expect(plan.work).toEqual(expect.arrayContaining([expect.objectContaining({ workId: state.assessmentId, estimateMinutes: 120, estimateOrigin: 'agent' })]));
    expect((await api('time.record', { workId: state.assessmentId, minutes: 90 })).status).toBe(403);
    expect(await api('time.record', { workId: state.assessmentId, minutes: 90 }, true)).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('5. anonymous UI reads succeed; owner writes without the session are refused', async () => {
    for (const name of ['courses.list', 'assessments.list', 'sync.status', 'autonomy.read']) {
      expect(await api(name, name === 'autonomy.read' ? { courseId: state.courseId } : {})).toMatchObject({ status: 200, body: { ok: true } });
    }
    for (const [name, input] of [['autonomy.default.set', { courseId: state.courseId, level: 1 }]] as const) {
      expect((await api(name, input)).status).toBe(403);
      expect(await api(name, input, true)).toMatchObject({ status: 200, body: { ok: true } });
    }
    expect((await http('/api/agent/list')).status).toBe(403);
  });

  it('6. a preset conversation stores the synthetic reply and reopening does not resend', async () => {
    const created = await http('/api/agent/create', { courseId: state.courseId, assessmentId: state.assessmentId, preset: 'explain-assessment' }, true);
    expect(created).toMatchObject({ status: 200, body: { ok: true, data: { preset: 'explain-assessment', assessmentId: state.assessmentId } } });
    state.conversationId = created.body.data.id;
    await host.chat.waitForIdle(state.conversationId);
    expect(chatAgent.inputs).toHaveLength(1);
    expect(chatAgent.inputs[0]).toMatchObject({ prompt: expect.stringContaining('Explain the assessment requirements'), assessmentId: state.assessmentId, preset: 'explain-assessment' });
    for (let i = 0; i < 2; i++) {
      const opened = (await http(`/api/agent/open?conversation=${encodeURIComponent(state.conversationId)}`, undefined, true)).body.data;
      expect(opened.messages.map((m: { role: string }) => m.role)).toEqual(['owner', 'agent']);
      expect(opened.messages[1].parts).toEqual(expect.arrayContaining([{ type: 'text', text: 'First' }, { type: 'text', text: ' second' }]));
    }
    expect(chatAgent.inputs).toHaveLength(1);
  });

  it('7. the agent records a lecture page with source.record and a note citing it is accepted', async () => {
    const text = 'Synthetic lecture: recursion needs a base case.';
    const recorded = await agentCall('source.record', { courseId: state.courseId, url: 'https://canvas.lms.unimelb.edu.au/courses/1/files/3', title: 'Week 1 lecture', text, page: 1 });
    expect(recorded).toMatchObject({ ok: true, data: { copiedBy: 'agent', locator: 'page:1' } });
    const { sourceItemId, sourceRevision } = (recorded as { data: { sourceItemId: string; sourceRevision: string } }).data;
    expect(await api('sources.get', { sourceItemId })).toMatchObject({ status: 200, body: { ok: true, data: { copiedBy: 'agent', text } } });
    expect(await agentCall('revision.write', { courseId: state.courseId, sourceRevision,
      claims: [{ text: 'Recursion needs a base case.', citations: [{ sourceItemId, quote: 'recursion needs a base case', locator: 'page:1' }] }] })).toMatchObject({ ok: true });
  });

  it('8. audit lists the owner level change; metrics report sync, accuracy, estimates and the conversation', async () => {
    const audit = (await api('audit.list', { limit: 100 })).body.data.items as Record<string, unknown>[];
    expect(audit.some(row => row.command === 'autonomy.default.set' && row.courseId === state.courseId)).toBe(true);
    expect(audit.some(row => String(row.command).startsWith('browser.') || String(row.command).startsWith('confirmation.'))).toBe(false);
    const metrics = await api('metrics.read', { from: '2026-01-01T00:00:00Z', to: new Date(Date.now() + 86_400_000).toISOString() });
    expect(metrics).toMatchObject({ status: 200, body: { ok: true, data: {
      // The NEEDS_SELECTION run counts neither way; the reading run succeeded.
      sync: { runs: { available: true, count: 1, successRate: 1 }, canvas: { available: false }, ed: { available: false } },
      accuracy: { available: true, count: 1, correct: 1, incorrect: 0, value: 1 },
      estimates: { available: true, count: 1, medianRatio: 0.75 },
      agent: { available: true, conversations: expect.arrayContaining([
        expect.objectContaining({ conversationId: state.conversationId, steps: 1, turns: 14, cost: expect.objectContaining({ totalUsd: 0.42 }) })]) },
    } } });
  });
});
