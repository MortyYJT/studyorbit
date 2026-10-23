/**
 * Task 17.1: one synthetic walk through the v1 delivery flow on the production composition.
 * Every step shares one temporary COURSEWORK_HOME and one owner UI host bound to a real loopback socket.
 * Only the provider readers (Canvas/Ed JSON), the tool browser page and the chat agent are fakes; all data is invented.
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
import { SyncService } from '../../src/sync/service.js';
import type { ToolPage } from '../../src/browser/tools/ports.js';
import { SyntheticAdapter } from '../agent/synthetic.js';
import { bodies, clock, readers } from '../sync/delivery-fixture.js';

// Locally this file runs in about 2 s; sync, UI bootstrap and the confirmation polling get headroom on slow CI runners.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const quizName = 'Synthetic weekly quiz 1';
const quizUrl = 'https://canvas.lms.unimelb.edu.au/courses/1/quizzes/7';
// The shared delivery fixture, adjusted so the synced group is still open and its linked assignment reads as a quiz.
const providerBodies = { ...bodies(),
  '/api/v1/courses/1/assignment_groups?per_page=100&page=1': [{ id: 3, name: 'Weekly quizzes', group_weight: 30 }],
  '/api/v1/courses/1/assignments?per_page=100&page=1': [{ id: 7, name: quizName, assignment_group_id: 3, description: 'Synthetic quiz instructions', points_possible: 10 }],
  '/api/v1/courses/1/assignments/7/submissions/self': { assignment_id: 7, score: null, submitted_at: null, workflow_state: 'unsubmitted' },
};

describe('v1 delivery end to end (synthetic)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coursework-e2e-')));
  const ports = readers(providerBodies);
  const clicks = vi.fn(async () => {});
  const page: ToolPage = { navigate: async () => {}, url: () => quizUrl, signedOut: async () => false,
    read: async () => ({ text: 'Synthetic quiz page', targets: [{ ref: 'r1', kind: 'button', description: 'Submit synthetic quiz' }], people: [], peers: [] }),
    front: async () => {}, highlight: async () => {}, isVisible: async () => true, act: clicks, screenshot: async () => 'shot-1', close: async () => {} };
  const adapter = new SyntheticAdapter();
  let tick = 0;
  let store: SqliteRepository; let host: ReturnType<typeof createProductionProtocol>; let transport: HttpTransport; let secret = '';
  const state = { courseId: '', assessmentId: '', annotationId: '', conversationId: '' };

  beforeAll(async () => {
    vi.stubEnv('COURSEWORK_HOME', root);
    const ui = join(root, 'ui'); mkdirSync(ui); writeFileSync(join(ui, 'index.html'), '<html>synthetic</html>');
    store = new SqliteRepository(databasePath());
    const sync = new SyncService({ store, clock: clock(), readers: async limiter => ({
      canvas: { read: p => limiter.attempt(() => ports.canvas.read(p)) }, ed: { read: p => limiter.attempt(() => ports.ed.read(p)) } }) });
    host = createProductionProtocol({ store, sync, agentAdapter: adapter, owner: { assertOwner: async () => { throw new Error('No terminal owner in this test.'); } },
      browserTools: { browser: { newPage: async () => page, close: async () => {} }, clock: { now: () => tick, sleep: async ms => { tick += ms; } } } });
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

  it('1. reports no sync history and a signed-out browser before any sync', async () => {
    expect(await api('sync.status')).toMatchObject({ status: 200, body: { ok: true, data: { running: false, canvas: {}, ed: {} } } });
    // No resident browser is running in the temporary home, so status asks the owner to sign in.
    expect(await api('browser.status')).toMatchObject({ status: 401, body: { ok: false, error: { code: 'AUTH_EXPIRED' } } });
    expect(ports.read).not.toHaveBeenCalled();
  });

  it('2. owner sync stores the synthetic course and assessment, then lists show them', async () => {
    expect((await api('sync.run')).status).toBe(403);
    expect(ports.read).not.toHaveBeenCalled();
    const run = await api('sync.run', {}, true);
    expect(run).toMatchObject({ status: 200, body: { ok: true, data: { providers: { canvas: { status: 'OK' }, ed: { status: 'OK' } } } } });
    expect(await api('sync.status')).toMatchObject({ body: { data: { canvas: { lastSuccess: { id: run.body.data.run.id } } } } });
    const courses = (await api('courses.list')).body.data.items;
    expect(courses).toEqual([expect.objectContaining({ code: 'ABCD10001', name: 'Synthetic Canvas', sources: expect.arrayContaining([{ platform: 'canvas', externalId: '1' }]) })]);
    const assessments = (await api('assessments.list')).body.data.items;
    expect(assessments).toEqual([expect.objectContaining({ name: 'Weekly quizzes', weight: 30, platform: expect.objectContaining({ submitted: false }) })]);
    expect(assessments[0].fields.kind.value).toBeNull();
    state.courseId = courses[0].id; state.assessmentId = assessments[0].id;
  });

  it('3. an agent annotation with a verified citation is confirmed by the owner over HTTP', async () => {
    const source = store.readAssessmentLinks(state.assessmentId).map(link => store.loadSourceItem(link.sourceItemId)!).find(item => item.title === quizName)!;
    const sourceRevision = (await api('revision.read', { courseId: state.courseId })).body.data.sourceRevision;
    const recorded = await agentCall('annotation.record', { entity: 'assessment', entityId: state.assessmentId, field: 'kind', value: 'quiz', sourceRevision,
      citations: [{ sourceItemId: source.id, quote: `name: ${quizName}`, locator: source.id }] });
    expect(recorded).toMatchObject({ ok: true, data: { citations: [expect.objectContaining({ sourceItemId: source.id })] } });
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
    const plan = (await api('plan.read', { term: '2026:S2', startDate: today, horizonDays: 7 })).body.data;
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
    for (const [name, input] of [['autonomy.default.set', { courseId: state.courseId, level: 1 }], ['autonomy.confirmation.set', { courseId: state.courseId, confirmBeforeSubmit: true }]] as const) {
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
    expect(adapter.inputs).toHaveLength(1);
    expect(adapter.inputs[0]).toMatchObject({ prompt: expect.stringContaining('Explain the assessment requirements'), assessmentId: state.assessmentId, preset: 'explain-assessment' });
    for (let i = 0; i < 2; i++) {
      const opened = (await http(`/api/agent/open?conversation=${encodeURIComponent(state.conversationId)}`, undefined, true)).body.data;
      expect(opened.messages.map((m: { role: string }) => m.role)).toEqual(['owner', 'agent']);
      expect(opened.messages[1].parts).toEqual(expect.arrayContaining([{ type: 'text', text: 'First' }, { type: 'text', text: ' second' }]));
    }
    expect(adapter.inputs).toHaveLength(1);
  });

  it('7. browser.submit on the L1 quiz waits for owner confirmation, then clicks exactly once', async () => {
    const opened = await agentCall('browser.open', { url: quizUrl });
    expect(opened).toMatchObject({ ok: true });
    const tabId = (opened as { data: { tabId: string } }).data.tabId;
    expect(await agentCall('browser.read', { tabId })).toMatchObject({ ok: true, data: { targets: [expect.objectContaining({ ref: 'r1' })] } });
    const submitted = agentCall('browser.submit', { tabId, assessmentId: state.assessmentId, ref: 'r1', summary: 'Synthetic quiz answers' });
    let pending: any[] = [];
    for (let i = 0; i < 200 && !pending.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      pending = (await api('confirmation.list', {}, true)).body.data.items;
    }
    expect(pending).toEqual([expect.objectContaining({ assessmentId: state.assessmentId, summary: 'Synthetic quiz answers', state: 'pending' })]);
    expect(clicks).not.toHaveBeenCalled();
    expect((await api('confirmation.list')).status).toBe(403);
    const decision = { confirmationId: pending[0].id, decision: 'confirmed' };
    expect((await api('confirmation.decide', decision)).status).toBe(403);
    expect(await api('confirmation.decide', decision, true)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await submitted).toMatchObject({ ok: true, data: { outcome: 'success' } });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(await api('confirmation.decide', decision, true)).toMatchObject({ body: { ok: false } });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect((await api('confirmation.list', {}, true)).body.data.items).toEqual([]);
  });

  it('8. audit lists the browser writes and confirmation; metrics report sync, accuracy, estimates and the conversation', async () => {
    const audit = (await api('audit.list', { limit: 100 })).body.data.items as Record<string, unknown>[];
    expect(audit.filter(row => row.command === 'browser.submit' && row.phase === 'outcome'))
      .toEqual([expect.objectContaining({ assessmentId: state.assessmentId, outcome: 'success', confirmation: 'owner-ui' })]);
    expect(audit.some(row => row.command === 'confirmation.decide')).toBe(true);
    const metrics = await api('metrics.read', { from: '2026-01-01T00:00:00Z', to: new Date(Date.now() + 86_400_000).toISOString() });
    expect(metrics).toMatchObject({ status: 200, body: { ok: true, data: {
      sync: { canvas: { available: true, count: 1, successRate: 1 }, ed: { available: true, count: 1, successRate: 1 } },
      accuracy: { available: true, count: 1, correct: 1, incorrect: 0, value: 1 },
      estimates: { available: true, count: 1, medianRatio: 0.75 },
      agent: { available: true, conversations: expect.arrayContaining([
        expect.objectContaining({ conversationId: state.conversationId, steps: 1, turns: 14, cost: expect.objectContaining({ totalUsd: 0.42 }) })]) },
    } } });
  });
});
