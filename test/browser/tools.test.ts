import { afterEach, expect, it, vi } from 'vitest';
import { BrowserTools } from '../../src/browser/tools/service.js';
import type { ToolPage, PageSnapshot } from '../../src/browser/tools/ports.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { AssessmentAutonomy } from '../../src/protocol/autonomy.js';
import type { AuditEvent } from '../../src/protocol/context.js';
import type { AgentEvent } from '../../src/agent/adapter.js';
import { CANVAS_ORIGIN } from '../../src/sync/ed-scope.js';
import type { PendingConfirmation } from '../../src/domain/schemas.js';
import { synthetic } from '../fixtures/synthetic.js';

const quiz = `${CANVAS_ORIGIN}/courses/42/quizzes/7`;
class FakePage implements ToolPage {
  location = quiz; calls: string[] = []; visible = true; now = 0;
  snapshot: PageSnapshot = { text: 'Question: 12345678', targets: [{ ref: 'r1', description: 'Answer', kind: 'input' }], people: [], peers: [] };
  async navigate(url: string) { this.location = url; this.calls.push('navigate'); }
  url() { return this.location; }
  async signedOut() { return /login/.test(this.location); }
  async read() { return this.snapshot; }
  async front() { this.calls.push('front'); }
  async highlight() { this.calls.push('highlight'); }
  async isVisible() { return this.visible; }
  async act(action: string) { this.calls.push(action === 'submit' ? 'click' : action); }
  async screenshot() { this.calls.push('screenshot'); return 'shot-1'; }
  async close() { this.calls.push('close'); }
}
const stores: SqliteRepository[] = []; const services: BrowserTools[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); stores.splice(0).forEach(s => s.close()); vi.useRealTimers(); });
function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  store.saveBatch({ modules: [synthetic.module], courses: [{ ...synthetic.course, sources: [{ platform: 'canvas', externalId: '42' }, { platform: 'ed', externalId: '43' }] }],
    assessments: [{ ...synthetic.assessments[0]!, id: 'a', kind: 'quiz' }] });
  store.appendCourseAutonomy({ courseId: synthetic.course.id, defaultLevel: 1, confirmBeforeSubmit: true, at: new Date().toISOString() });
  const events: AuditEvent[] = []; const steps: AgentEvent[] = []; const page = new FakePage();
  const audit = { record: vi.fn(async (e: AuditEvent) => { events.push(e); }) };
  const autonomy = new AssessmentAutonomy(store, audit);
  const newPage = vi.fn(async () => page);
  const confirmations = new Map<string, PendingConfirmation>();
  const confirmationStore = { list: () => [...confirmations.values()], save: (row: PendingConfirmation) => { confirmations.set(row.id, row); } };
  const service = new BrowserTools({ store, autonomy, audit, confirmations: confirmationStore, browser: { newPage, close: async () => {} },
    clock: { now: () => page.now, sleep: async ms => { page.now += ms; } } }); services.push(service);
  const scope = { conversationId: 'chat-1', emit: (e: AgentEvent) => { steps.push(e); } };
  store.appendConversation({ id: 'chat-1', title: 'Synthetic', adapter: 'fake', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const call = (name: string, input: unknown) => service.execute(name, input, scope);
  const open = async (url = quiz) => { const result = await call('browser.open', { url }); return result.tabId as string; };
  const read = async (tabId: string) => call('browser.read', { tabId });
  const write = (tabId: string, action = 'fill') => call(`browser.${action}`, { tabId, assessmentId: 'a', ref: 'r1', ...(action === 'fill' ? { value: 'Synthetic answer' } : action === 'select' ? { value: 'option-a' } : {}) });
  return { confirmationStore, store, page, service, audit, events, steps, scope, call, open, read, write, newPage };
}
it.each(['http://localhost:3000/', 'http://127.0.0.1:5000/', 'https://example.invalid/', `${CANVAS_ORIGIN}/login`, `${CANVAS_ORIGIN}/courses/42?token=secret`])('11.1 refuses unsafe URL %s before opening', async url => {
  const s = setup(); await expect(s.open(url)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|AUTH_EXPIRED/) }); expect(s.newPage).not.toHaveBeenCalled();
});
it('11.1 refuses unowned tabs and sign-in/off-origin landings without exposing page data', async () => {
  const s = setup(); await expect(s.read('owner-tab')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  s.page.navigate = async () => { s.page.location = 'https://sso.invalid/login'; };
  await expect(s.open()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' }); expect(s.page.calls).toEqual(['close']);
  s.page.navigate = async () => { s.page.location = 'https://elsewhere.invalid/page'; };
  await expect(s.open()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it.each([quiz, 'https://edstem.org/au/courses/43/lessons/7/attempt', 'https://edstem.org/au/courses/43/lessons/7/slides/2'])('11.2 preserves quiz/workshop text and masks peer sections: %s', async url => {
  const s = setup(); s.page.snapshot.text += ' Peer answer: private'; s.page.snapshot.peers = ['Peer answer: private'];
  const tabId = await s.open(url); const result = await s.read(tabId);
  expect(result.text).toBe('Question: 12345678 [redacted]');
});
it('11.2 refuses discussion before extracting any content', async () => {
  const s = setup(); const tabId = await s.open('https://edstem.org/au/courses/43/discussion/99'); const read = vi.spyOn(s.page, 'read');
  await expect(s.read(tabId)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(read).not.toHaveBeenCalled();
});
it('11.2 redacts other pages, targets and bounds the total output', async () => {
  const s = setup(); s.page.snapshot = { text: 'Alex Fixture says hello. ' + 'z'.repeat(70000), people: ['Alex Fixture'], peers: [], targets: [{ ref: 'r1', description: 'Alex Fixture', kind: 'button' }] };
  const result = await s.read(await s.open(`${CANVAS_ORIGIN}/courses/42/announcements/1`));
  expect(JSON.stringify(result)).not.toContain('Alex Fixture'); expect(JSON.stringify(result).length).toBeLessThan(50000); expect(result.truncated).toBe(true);
});
it.each([`${CANVAS_ORIGIN}/courses/99/quizzes/7`, 'https://edstem.org/au/courses/99/lessons/7/attempt'])('11.3 rejects course/platform mismatch before highlight %s', async url => {
  const s = setup(); const tab = await s.open(url); await s.read(tab); await expect(s.write(tab)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(s.page.calls).not.toContain('highlight');
});
it('11.3 denied check types nothing and audits denial', async () => {
  const s = setup(); s.store.appendCourseAutonomy({ courseId: synthetic.course.id, defaultLevel: 0, confirmBeforeSubmit: true, at: new Date().toISOString() });
  const tab = await s.open(); await s.read(tab); await expect(s.write(tab)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('grant-level') });
  expect(s.page.calls).not.toContain('fill'); expect(s.events).toContainEqual(expect.objectContaining({ command: 'browser.fill', phase: 'denial', reason: 'grant-level' }));
});
it.each(['fill', 'click', 'select'])('11.3 allowed %s highlights for one second, acts once, screenshots and audits without answers', async action => {
  const s = setup(); const tab = await s.open(); await s.read(tab); await s.write(tab, action);
  expect(s.page.now).toBeGreaterThanOrEqual(1000); expect(s.page.calls.slice(-4)).toEqual(['front', 'highlight', action, 'screenshot']);
  expect(s.events.filter(e => e.command === `browser.${action}`)).toEqual([expect.objectContaining({ action, outcome: 'success', level: 1 })]);
  expect(JSON.stringify(s.events)).not.toContain('Synthetic answer');
});
it('11.3 audit unavailable denies before action; post-action audit failure is uncertain without retry', async () => {
  const s = setup(); const tab = await s.open(); await s.read(tab);
  s.audit.record.mockRejectedValueOnce(new Error('private diagnostics'));
  await expect(s.write(tab)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(s.page.calls).not.toContain('fill');
  s.audit.record.mockImplementation(async e => { if (e.command === 'browser.fill') throw new Error('audit offline'); s.events.push(e); });
  await expect(s.write(tab)).rejects.toMatchObject({ code: 'UNCERTAIN' }); expect(s.page.calls.filter(c => c === 'fill')).toHaveLength(1);
});
it('11.3 rechecks the page, grant and target after the highlight wait', async () => {
  const s = setup(); const tab = await s.open(); await s.read(tab);
  s.page.highlight = async () => { s.page.location = `${CANVAS_ORIGIN}/courses/99/quizzes/1`; };
  await expect(s.write(tab)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(s.page.calls).not.toContain('fill');
});
async function pending(s: ReturnType<typeof setup>) {
  const tab = await s.open(); await s.read(tab);
  const promise = s.call('browser.submit', { tabId: tab, assessmentId: 'a', ref: 'r1', summary: 'Answer 1: synthetic' });
  let row;
  for (let i = 0; i < 100 && !row; i++) { await Promise.resolve(); row = s.service.pending()[0]; }
  expect(row).toMatchObject({ summary: 'Answer 1: synthetic', screenshotRef: 'shot-1', state: 'pending' });
  return { tab, promise, id: row!.id };
}
const owner = { assertOwner: async () => {} };
it('11.4 owner confirms once; no MCP or missing session can consume confirmation', async () => {
  const s = setup(); const p = await pending(s);
  await expect(s.service.decide(p.id, 'confirmed')).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(s.service.pending()).toHaveLength(1);
  await s.service.decide(p.id, 'confirmed', owner); await p.promise;
  await expect(s.service.decide(p.id, 'confirmed', owner)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(s.page.calls.filter(c => c === 'click')).toHaveLength(1); expect(s.events.at(-1)).toMatchObject({ action: 'submit', confirmation: 'owner-ui', outcome: 'success' });
});
it.each(['cancelled', 'expired', 'restart'] as const)('11.4 %s leaves submission untouched and records the outcome', async state => {
  vi.useFakeTimers(); const s = setup(); const p = await pending(s);
  if (state === 'restart') await s.service.close(); else if (state === 'expired') await vi.advanceTimersByTimeAsync(15 * 60 * 1000); else await s.service.decide(p.id, state, owner);
  expect(await p.promise).toMatchObject({ outcome: state === 'restart' ? 'expired' : state }); expect(s.page.calls).not.toContain('click');
  expect(s.events.at(-1)).toMatchObject({ action: 'submit', outcome: 'failure' });
});
it('11.4 confirmation disabled submits with not-required and no pending entry', async () => {
  const s = setup(); s.store.appendCourseAutonomy({ courseId: synthetic.course.id, defaultLevel: 1, confirmBeforeSubmit: false, at: new Date().toISOString() });
  const tab = await s.open(); await s.read(tab); await s.call('browser.submit', { tabId: tab, assessmentId: 'a', ref: 'r1', summary: 'Synthetic' });
  expect(s.service.pending()).toEqual([]); expect(s.events.at(-1)).toMatchObject({ confirmation: 'not-required' });
});
it('11.5 four ordered steps include waiting confirmation, screenshot and view in Edge', async () => {
  const s = setup(); const tab = await s.open(); await s.read(tab); s.steps.length = 1;
  await s.write(tab); await s.write(tab);
  const promise = s.call('browser.submit', { tabId: tab, assessmentId: 'a', ref: 'r1', summary: 'Synthetic' });
  for (let i = 0; i < 100 && !s.service.pending().length; i++) await Promise.resolve();
  const steps = s.steps.filter(e => e.type === 'tool_step');
  expect(steps.map(e => e.tool)).toEqual(['browser.open', 'browser.fill', 'browser.fill', 'browser.submit']);
  expect(steps.at(-1)).toMatchObject({ outcome: 'waiting', screenshotRef: 'shot-1', viewUrl: expect.stringContaining(tab) });
  await s.service.decide(s.service.pending()[0]!.id, 'cancelled', owner); await promise;
});
it('11.3 rejects a changed document after owner confirmation before highlighting', async () => {
  const s = setup(); const p = await pending(s);
  s.page.location = `${CANVAS_ORIGIN}/courses/42/quizzes/8`;
  await s.service.decide(p.id, 'confirmed', owner);
  await expect(p.promise).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(s.page.calls).not.toContain('highlight');
});
it('11.2 strips peer identities even in quiz target descriptions', async () => {
  const s = setup(); s.page.snapshot.people = ['Alex Fixture'];
  s.page.snapshot.targets[0]!.description = 'ALEX   FIXTURE';
  const result = await s.read(await s.open());
  expect(JSON.stringify(result)).not.toMatch(/Alex\s+Fixture/i);
});
it('11.5 cancellation updates the waiting step with the observed outcome', async () => {
  const s = setup(); const p = await pending(s);
  await s.service.decide(p.id, 'cancelled', owner); await p.promise;
  expect(s.steps.filter(e => e.type === 'tool_step').at(-1)).toMatchObject({ tool: 'browser.submit', outcome: 'denied', output: { outcome: 'cancelled' } });
});
it('11.3 audits a wrong-course refusal with trusted metadata and no page prose', async () => {
  const s = setup(); const tab = await s.open(`${CANVAS_ORIGIN}/courses/99/quizzes/7`);
  await expect(s.write(tab)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(s.events.filter(e => e.command === 'browser.fill')).toEqual([expect.objectContaining({ phase: 'denial', action: 'fill', assessmentId: 'a', conversationId: 'chat-1' })]);
});
it('11.4 records cancellation distinctly from expiration', async () => {
  const s = setup(); const p = await pending(s); await s.service.decide(p.id, 'cancelled', owner); await p.promise;
  expect(s.events.at(-1)).toMatchObject({ submissionState: 'cancelled' });
});
it('11.3 stopped conversations cannot release writes during the highlight wait', async () => {
  const s = setup(); let active = true; const scope = { ...s.scope, isActive: () => active };
  const { tabId } = await s.service.execute('browser.open', { url: quiz }, scope);
  await s.service.execute('browser.read', { tabId }, scope);
  s.page.highlight = async () => { active = false; };
  await expect(s.service.execute('browser.fill', { tabId, assessmentId: 'a', ref: 'r1', value: 'Synthetic' }, scope)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(s.page.calls).not.toContain('fill');
});
it('11.4 browser.click cannot bypass confirmation on a submit control', async () => {
  const s = setup(); s.page.snapshot.targets[0]!.kind = 'submit'; const tab = await s.open(); await s.read(tab);
  await expect(s.write(tab, 'click')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(s.page.calls).not.toContain('click'); expect(s.page.calls).not.toContain('highlight');
});

it('11.4 confirmation persistence failure does not release or replay the pending click', async () => {
  const s = setup(); const p = await pending(s);
  s.confirmationStore.save = () => { throw new Error('Synthetic storage outage'); };
  await expect(s.service.decide(p.id, 'confirmed', owner)).rejects.toMatchObject({ code: 'INTERNAL' });
  expect(await p.promise).toMatchObject({ outcome: 'expired' }); expect(s.page.calls).not.toContain('click');
});
it('11.2 unicode page output remains within the protocol byte limit', async () => {
  const s = setup(); s.page.snapshot.text = '测'.repeat(9000);
  s.page.snapshot.targets = Array.from({ length: 60 }, (_, i) => ({ ref: `r${i}`, kind: 'button', description: '答'.repeat(200) }));
  const result = await s.read(await s.open()); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(60000);
});
it('11.5 step journal failure after acting reports uncertainty without retry or raw diagnostics', async () => {
  const s = setup(); const tab = await s.open(); await s.read(tab);
  s.scope.emit = () => { throw new Error('Synthetic private SQLite diagnostics'); };
  await expect(s.write(tab)).rejects.toMatchObject({ code: 'UNCERTAIN', message: expect.not.stringContaining('SQLite') });
  expect(s.page.calls.filter(c => c === 'fill')).toHaveLength(1);
});

it('11.2 quiz privacy removes contact details and rejects credential syntax without losing mathematics', async () => {
  const s = setup(); const tab = await s.open();
  s.page.snapshot.people = ['Alex Fixture'];
  s.page.snapshot.text = 'Alex Fixture alex.fixture@example.invalid +61 412 345 678 student id: 7654321; x < 12345678';
  s.page.snapshot.targets[0]!.description = 'alex.fixture@example.invalid';
  const result = await s.read(tab);
  expect(result.text).toContain('x < 12345678');
  expect(JSON.stringify(result)).not.toMatch(/Alex Fixture|example\.invalid|412 345 678|7654321/);
  for (const credential of ['Authorization: Bearer synthetic-private', 'Bearer synthetic-private', 'x-token: synthetic-private', 'api-key=synthetic-private', 'session_id=synthetic-private', 'https://example.invalid/?access_token=synthetic-private']) {
    s.page.snapshot.text = credential;
    await expect(s.read(tab)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  }
});
