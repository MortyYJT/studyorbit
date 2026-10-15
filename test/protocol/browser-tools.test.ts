import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch, isOwnerCommand } from '../../src/protocol/registry.js';
import type { AgentAdapter, AgentEvent } from '../../src/agent/adapter.js';
import type { ToolPage } from '../../src/browser/tools/ports.js';
import { synthetic } from '../fixtures/synthetic.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
it('11.1/11.4/11.5 production tools persist steps, session-only confirmations and one audited submit', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-tools-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true })); vi.stubEnv('COURSEWORK_HOME', root);
  const clicks = vi.fn(async () => {});
  const page: ToolPage = { navigate: async () => {}, url: () => 'https://canvas.lms.unimelb.edu.au/courses/42/quizzes/7', signedOut: async () => false,
    read: async () => ({ text: 'Synthetic quiz', targets: [{ ref: 'r1', kind: 'button', description: 'Submit synthetic quiz' }], people: [], peers: [] }),
    front: async () => {}, highlight: async () => {}, isVisible: async () => true, act: clicks, screenshot: async () => 'shot-1', close: async () => {} };
  const adapter: AgentAdapter = { id: 'fake', start: input => ({ interrupt() {}, async *[Symbol.asyncIterator]() {
    const call = async (name: string, value: unknown) => input.tools.find(t => t.name === name)!.execute(value) as Promise<any>;
    const { tabId } = await call('browser.open', { url: page.url() });
    await call('browser.read', { tabId });
    await call('browser.submit', { tabId, assessmentId: 'a', ref: 'r1', summary: 'Synthetic answer summary' });
    yield { type: 'result', turns: 1 } as AgentEvent;
  } }) };
  let tick = 0;
  const host = createProductionProtocol({ agentAdapter: adapter, browserTools: { browser: { newPage: async () => page, close: async () => {} }, clock: { now: () => tick, sleep: async ms => { tick += ms; } } } });
  cleanup.push(() => host.close());
  host.store.saveBatch({ modules: [synthetic.module], courses: [{ ...synthetic.course, sources: [{ platform: 'canvas', externalId: '42' }] }], assessments: [{ ...synthetic.assessments[0]!, id: 'a', kind: 'quiz' }] });
  host.store.appendCourseAutonomy({ courseId: synthetic.course.id, defaultLevel: 1, confirmBeforeSubmit: true, at: new Date().toISOString() });
  const owner = { assertOwner: async () => {} };
  const conversation = await host.chat.create({}, owner); await host.chat.send(conversation.id, 'Synthetic task', owner);
  for (let i = 0; i < 100 && !host.browserTools.pending().length; i++) await new Promise(r => setTimeout(r, 2));
  const row = host.browserTools.pending()[0]!; expect(row).toMatchObject({ summary: 'Synthetic answer summary', state: 'pending' }); expect(clicks).not.toHaveBeenCalled();
  const agent = host.registry.agentTools(host.context);
  expect(agent.registry.get('browser.submit')).toBeDefined(); expect(agent.registry.get('confirmation.decide')).toBeUndefined();
  expect(isOwnerCommand(host.registry.get('confirmation.list')!)).toBe(true);
  expect(await dispatch(agent.registry, 'confirmation.decide', { confirmationId: row.id, decision: 'confirmed' }, agent.context)).toMatchObject({ ok: false });
  expect(await dispatch(host.registry, 'confirmation.decide', { confirmationId: row.id, decision: 'confirmed' }, { ...host.context, owner: undefined })).toMatchObject({ ok: false });
  expect(await dispatch(host.registry, 'confirmation.list', {}, { ...host.context, owner })).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ id: row.id })] } });
  expect(await dispatch(host.registry, 'confirmation.decide', { confirmationId: row.id, decision: 'confirmed' }, { ...host.context, owner })).toMatchObject({ ok: true });
  await host.chat.waitForIdle(conversation.id); expect(clicks).toHaveBeenCalledTimes(1);
  const steps = host.chat.events(conversation.id).filter(e => e.event.type === 'tool_step');
  expect(steps.map(e => e.event.type === 'tool_step' && e.event.outcome)).toEqual(['ok', 'ok', 'waiting', 'ok']);
  expect(steps.at(-1)!.event).toMatchObject({ screenshotRef: 'shot-1', viewUrl: expect.stringContaining('browser.view'), input: { target: 'Submit synthetic quiz' } });
  const writes = (await host.audit.list()).filter(e => e.command === 'browser.submit');
  expect(writes).toEqual([expect.objectContaining({ assessmentId: 'a', outcome: 'success', confirmation: 'owner-ui', conversationId: conversation.id })]);
  // External MCP dispatch receives a host-created conversation, never caller authority.
  const opened = await dispatch(agent.registry, 'browser.open', { url: page.url() }, agent.context);
  expect(opened).toMatchObject({ ok: true });
  const externalTab = (opened as { data: any }).data.tabId;
  await dispatch(agent.registry, 'browser.read', { tabId: externalTab }, agent.context);
  const submitted = dispatch(agent.registry, 'browser.submit', { tabId: externalTab, assessmentId: 'a', ref: 'r1', summary: 'External synthetic summary' }, agent.context);
  for (let i = 0; i < 100 && !host.browserTools.pending().length; i++) await new Promise(r => setTimeout(r, 2));
  const ui = createProductionProtocol(); cleanup.push(() => ui.close());
  const external = ui.browserTools.pending()[0];
  expect(external).toBeDefined();
  if (!external) { await submitted; return; }
  expect(external.conversationId).not.toBe(conversation.id);
  expect(host.chat.events(external.conversationId).at(-1)!.event).toMatchObject({ type: 'confirmation', decision: 'pending' });
  await dispatch(ui.registry, 'confirmation.decide', { confirmationId: external.id, decision: 'confirmed' }, { ...ui.context, owner });
  expect(await submitted).toMatchObject({ ok: true }); expect(clicks).toHaveBeenCalledTimes(2);
});
it('11.5 creates a fresh MCP step journal after the owner deletes the previous one', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-journal-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true })); vi.stubEnv('COURSEWORK_HOME', root);
  const page: ToolPage = { navigate: async () => {}, url: () => 'https://canvas.lms.unimelb.edu.au/courses/42/quizzes/7', signedOut: async () => false,
    read: async () => ({ text: 'Synthetic quiz', targets: [], people: [], peers: [] }), front: async () => {}, highlight: async () => {},
    isVisible: async () => true, act: async () => {}, screenshot: async () => 'shot-1', close: async () => {} };
  const host = createProductionProtocol({ browserTools: { browser: { newPage: async () => page, close: async () => {} } } });
  cleanup.push(() => host.close());
  const agent = host.registry.agentTools(host.context);
  const open = () => dispatch(agent.registry, 'browser.open', { url: page.url() }, agent.context);
  expect(await open()).toMatchObject({ ok: true });
  const previous = host.chat.list()[0]!.id;
  await host.chat.delete(previous, { assertOwner: async () => {} });
  const next = await open(); expect(next).toMatchObject({ ok: true });
  const conversation = host.chat.list()[0]!; expect(conversation.id).not.toBe(previous);
  expect(host.chat.events(conversation.id)).toHaveLength(1);
  expect(host.chat.events(conversation.id)[0]!.event).toMatchObject({ type: 'tool_step', tool: 'browser.open', outcome: 'ok' });
});
