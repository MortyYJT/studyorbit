import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { ConversationService } from '../../src/agent/conversations.js';
import { SyntheticAdapter } from './synthetic.js';
import { presets } from '../../src/agent/presets.js';
const owner = { assertOwner: async () => {} };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function setup(adapter = new SyntheticAdapter(), path = ':memory:') {
  const store = new SqliteRepository(path); cleanups.push(() => store.close());
  store.saveModule({ id: 'm-1', name: 'Synthetic', glyph: 'S', auto: false });
  store.saveCourse({ id: 'c-1', moduleId: 'm-1', code: 'TEST10001', name: 'Synthetic course', term: 'synthetic', assessmentsComplete: true });
  store.saveAssessment({ id: 'a-1', courseId: 'c-1', name: 'Synthetic assessment', kind: 'assignment', isFinal: false, status: 'not_started' });
  store.saveAssessment({ id: 'exam-1', courseId: 'c-1', name: 'Synthetic final', kind: 'exam', isFinal: true, status: 'not_started' });
  const service = new ConversationService(store, adapter);
  return { store, service, adapter };
}
it('stores ordered owner/agent parts, resumes the session and survives restart with three messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.sqlite');
  const { service, store, adapter } = setup(undefined, path);
  const c = await service.create({ title: 'First', courseId: 'c-1', assessmentId: 'a-1' }, owner);
  const sent = await service.send(c.id, 'Hello', owner);
  expect(adapter.inputs).toHaveLength(0);
  await service.waitForIdle(c.id);
  expect(sent.messageId).toBeTruthy();
  expect(service.open(c.id).messages.map(m => m.role)).toEqual(['owner', 'agent']);
  expect(service.open(c.id).messages[1].parts).toEqual([
    { type: 'text', text: 'First' }, { type: 'text', text: ' second' },
    { type: 'tool_step', tool: 'sources.get', output: { outcome: 'ok', screenshotRef: 'shot-1' } },
  ]);
  await service.send(c.id, 'Again', owner); await service.waitForIdle(c.id);
  expect(adapter.inputs[1].sessionRef).toBe('session-1');
  expect(adapter.inputs[1].transcript).toHaveLength(2);
  // Include a stored owner-only third message, as after a crash before a reply starts.
  store.appendMessage({ id: 'third', conversationId: c.id, seq: 4, role: 'owner', parts: [{ type: 'text', text: 'Later' }], stopped: false, at: new Date().toISOString() });
  store.close();
  const reopened = new SqliteRepository(path); cleanups.push(() => reopened.close());
  const fresh = new ConversationService(reopened, new SyntheticAdapter());
  expect(fresh.list()[0].sessionRef).toBe('session-1');
  expect(fresh.open(c.id).messages.map(m => m.seq)).toEqual([0, 1, 2, 3, 4]);
  const newer = await fresh.create({ title: 'New' }, owner);
  expect(fresh.list().map(c => c.id)).toEqual([newer.id, c.id]);
  await expect(fresh.delete(c.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fresh.open(c.id).messages).toHaveLength(5);
  const runId = sent.messageId;
  await fresh.delete(c.id, owner);
  expect(reopened.readAgentRuns().find(run => run.id === runId)).toMatchObject({ courseId: 'c-1', assessmentId: 'a-1', turns: 14, costUsd: 0.42 });
  expect(() => fresh.open(c.id)).toThrow();
  expect(reopened.readMessages(c.id)).toEqual([]);
});
it('journals events without listeners and resumes after the last id without duplicates, including after restart', async () => {
  const { service, store } = setup();
  const c = await service.create({ title: 'Replay' }, owner);
  await service.send(c.id, 'Hello', owner); await service.waitForIdle(c.id);
  const all = service.events(c.id);
  expect(all.map(e => e.event.type)).toEqual(['text', 'text', 'tool_step', 'result']);
  const replay = new ConversationService(store, new SyntheticAdapter());
  expect(replay.events(c.id, all[1].id)).toEqual(all.slice(2));
  expect(replay.events(c.id, all.at(-1)!.id)).toEqual([]);
  expect(() => replay.events(c.id, 'bad')).toThrow();
});
it('stop interrupts a blocked adapter and commits partial text and one stopped run', async () => {
  const adapter = new SyntheticAdapter([{ type: 'text', text: 'Partial' }], new Promise(() => {}));
  const { service, store } = setup(adapter);
  const c = await service.create({ title: 'Stop' }, owner);
  const sent = await service.send(c.id, 'Hello', owner);
  // Stop only after the partial text is journaled; a fixed tick races the adapter.
  await vi.waitFor(() => expect(service.events(c.id).some(row => row.event.type === 'text')).toBe(true));
  await expect(service.send(c.id, 'Concurrent', owner)).rejects.toMatchObject({ code: 'LOCKED' });
  await service.stop(c.id, owner); await service.waitForIdle(c.id);
  expect(adapter.interrupted).toBe(1);
  expect(service.open(c.id).messages[1]).toMatchObject({ stopped: true, parts: [{ type: 'text', text: 'Partial' }] });
  expect(service.events(c.id).at(-1)!.event.type).toBe('stopped');
  expect(store.loadRun(sent.messageId)).toMatchObject({ conversationId: c.id, outcome: 'error', steps: 0, turns: 0 });
});
it('renders every preset from stored identities only; reload never sends twice and exams have no entry', async () => {
  const { service, adapter } = setup();
  expect(presets).toHaveLength(8);
  expect(service.availablePresets({ courseId: 'c-1', assessmentId: 'exam-1' })).toEqual([]);
  expect(service.availablePresets({ courseId: 'c-1', assessmentId: 'a-1' })).toHaveLength(8);
  expect(service.availablePresets({ courseId: 'c-1' })).toHaveLength(5);
  for (const preset of presets) {
    const c = await service.create({ preset: preset.id, courseId: 'c-1', ...(preset.assessment ? { assessmentId: 'a-1' } : {}) }, owner);
    await service.waitForIdle(c.id);
    const text = (service.open(c.id).messages[0].parts[0] as { text: string }).text;
    expect(text).toContain('c-1'); expect(text).toContain('Synthetic course');
    if (preset.assessment) { expect(text).toContain('a-1'); expect(text).toContain('Synthetic assessment'); }
    const count = adapter.inputs.length;
    service.open(c.id); service.open(c.id);
    expect(adapter.inputs).toHaveLength(count);
  }
  await expect(service.create({ preset: 'complete-assessment', courseId: 'c-1', assessmentId: 'exam-1' }, owner)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.create({ preset: 'complete-assessment', courseId: 'c-1', assessmentId: 'missing' }, owner)).rejects.toThrow();
  await expect(service.create({ preset: 'invented', courseId: 'c-1' }, owner)).rejects.toThrow();
});
it.each([0.42, undefined])('records reply steps, turns and reported cost (%s); missing cost stays unknown', async costUsd => {
  const { service, store } = setup(new SyntheticAdapter([
    { type: 'tool_step', tool: 'read', outcome: 'ok' }, { type: 'tool_step', tool: 'write', outcome: 'denied' },
    { type: 'result', turns: 14, ...(costUsd === undefined ? {} : { costUsd }) },
  ]));
  const c = await service.create({ title: 'Metrics', courseId: 'c-1', assessmentId: 'a-1' }, owner);
  const { messageId } = await service.send(c.id, 'Hello', owner); await service.waitForIdle(c.id);
  const run = store.loadRun(messageId)!;
  expect(run).toMatchObject({ command: 'agent.reply', conversationId: c.id, turns: 14, steps: 2, outcome: 'ok' });
  expect(run.costUsd).toBe(costUsd);
  expect(service.open(run.conversationId!).conversation.assessmentId).toBe('a-1');
});
it('forwards tool sets and transcript when no resumable session was reported; safe unavailable errors need no credentials', async () => {
  const adapter = new SyntheticAdapter([
    { type: 'text', text: 'Synthetic partial reply.' },
    { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'unsafe adapter diagnostic' },
  ]);
  const { store } = setup(adapter);
  const tools = [{ name: 'synthetic.read', description: 'Synthetic read', inputSchema: {}, execute: async () => ({}) }];
  const service = new ConversationService(store, adapter, tools);
  const c = await service.create({ title: 'Unavailable' }, owner);
  const sent = await service.send(c.id, 'Hello', owner); await service.waitForIdle(c.id);
  expect(service.events(c.id).at(-1)!.event).toEqual({ type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.' });
  expect(store.loadRun(sent.messageId)).toMatchObject({ outcome: 'error', errorCode: 'AGENT_UNAVAILABLE' });
  expect(service.open(c.id).messages[1].parts).toEqual([{ type: 'text', text: 'Synthetic partial reply.' }]);
  const reopened = new ConversationService(store, adapter);
  expect(reopened.open(c.id).events[0].event).toEqual({ type: 'text', text: 'Synthetic partial reply.' });
  await service.send(c.id, 'Retry', owner); await service.waitForIdle(c.id);
  expect(adapter.inputs[1]).toMatchObject({ tools, transcript: expect.arrayContaining([expect.objectContaining({ role: 'owner' }), expect.objectContaining({ role: 'agent' })]) });
  expect(adapter.inputs[1].sessionRef).toBeUndefined();
});
it('historical confirmation parts stay readable and reach the transcript without a resumable session', async () => {
  const decisions = [undefined, 'pending', 'confirmed', 'cancelled', 'expired'] as const;
  const parts = decisions.map((decision, index) => ({ type: 'confirmation' as const, confirmationId: `p${index}`,
    ...(decision === undefined ? {} : { decision }) }));
  const { service, store } = setup(new SyntheticAdapter([{ type: 'result', turns: 1 }]));
  const c = await service.create({ title: 'Confirmations' }, owner);
  await service.send(c.id, 'Decide', owner); await service.waitForIdle(c.id);
  const stored = service.open(c.id);
  // Rows written before the submit-confirmation flow was removed.
  store.saveChat(stored.conversation, { ...stored.messages[1]!, parts }, []);
  const adapter = new SyntheticAdapter();
  const restarted = new ConversationService(store, adapter);
  expect(restarted.open(c.id).messages[1].parts).toEqual(parts);
  await restarted.send(c.id, 'Continue', owner); await restarted.waitForIdle(c.id);
  expect(adapter.inputs[0].sessionRef).toBeUndefined();
  expect(adapter.inputs[0].transcript[1].parts).toEqual(parts);
});
it('recovers a partial reply after process restart and ignores late events after stop', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = new SyntheticAdapter([{ type: 'text', text: 'Partial' }], gate);
  const { service, store } = setup(adapter);
  const c = await service.create({ title: 'Crash' }, owner);
  const { messageId } = await service.send(c.id, 'Hello', owner);
  await vi.waitFor(() => expect(service.events(c.id).some(row => row.event.type === 'text')).toBe(true));
  // Every CLI/MCP process builds a service; only the owner UI host may recover, and only explicitly.
  const restarted = new ConversationService(store, new SyntheticAdapter());
  expect(restarted.open(c.id).messages[1].stopped).toBe(false);
  expect(restarted.events(c.id).map(e => e.event.type)).toEqual(['text']);
  restarted.recoverInterrupted();
  expect(restarted.open(c.id).messages[1].stopped).toBe(true);
  expect(store.loadRun(messageId)).toMatchObject({ errorCode: 'STOPPED' });
  await service.stop(c.id, owner); release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.events(c.id).map(e => e.event.type)).toEqual(['text', 'stopped']);
});
it('delete excludes a racing send so a deleted conversation never reappears', async () => {
  const { service } = setup(new SyntheticAdapter([{ type: 'text', text: 'Late' }]));
  for (let offset = 0; offset < 12; offset++) {
    const c = await service.create({ title: `Race ${offset}` }, owner);
    const deleted = service.delete(c.id, owner);
    for (let i = 0; i < offset; i++) await Promise.resolve();
    const sent = service.send(c.id, 'Hello', owner).catch(error => error);
    await deleted; await sent; await service.waitForIdle(c.id);
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    expect(service.list().some(row => row.id === c.id)).toBe(false);
  }
});
