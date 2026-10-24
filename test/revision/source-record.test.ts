import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';

const roots: string[] = []; const hosts: ReturnType<typeof createProductionProtocol>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.close(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const pdfURL = 'https://canvas.lms.unimelb.edu.au/courses/1/files/2';
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-record-'))); roots.push(root); vi.stubEnv('COURSEWORK_HOME', root);
  const host = createProductionProtocol(); hosts.push(host);
  host.store.saveCourse({ id: 'c', moduleId: 'm', code: 'SYN', name: 'Synthetic', term: 'test', assessmentsComplete: true,
    sources: [{ platform: 'canvas', externalId: '1' }, { platform: 'ed', externalId: '10' }] });
  host.store.saveCourse({ id: 'other', moduleId: 'm', code: 'OTH', name: 'Other', term: 'test', assessmentsComplete: true,
    sources: [{ platform: 'ed', externalId: '20' }] });
  const agent = host.registry.agentTools(host.context);
  const call = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context) as Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }>;
  const stored = () => host.store.query('sourceItems', { limit: 100 }).items;
  return { host, agent, call, stored };
}

it('Lecture PDF: one agent-copied material per page, and a note quoting page 2 passes the citation check', async () => {
  const { call, stored } = await setup();
  const pages = ['Synthetic first page.', 'Recursion needs a base case.', 'Synthetic third page.'];
  let last: { data?: any } = {};
  for (const [index, text] of pages.entries()) {
    last = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Week 3 lecture', text, page: index + 1 });
    expect(last).toMatchObject({ ok: true, data: { empty: false, page: index + 1, locator: `page:${index + 1}`, copiedBy: 'agent' } });
    expect(await call('sources.get', { sourceItemId: last.data.sourceItemId })).toMatchObject({ ok: true, data: { text, page: index + 1, copiedBy: 'agent' } });
  }
  const items = stored();
  expect(items).toHaveLength(3);
  expect(items.every(item => item.kind === 'material' && item.copiedBy === 'agent' && item.platform === 'canvas')).toBe(true);
  const page2 = items.find(item => item.text === pages[1])!;
  const sourceRevision = (await call('revision.read', { courseId: 'c' })).data.sourceRevision;
  expect(sourceRevision).toBe(last.data.sourceRevision);
  const note = { courseId: 'c', sourceRevision, claims: [{ text: 'Use a base case.', citations: [{ sourceItemId: page2.id, quote: 'Recursion needs a base case.', locator: 'page:2' }] }] };
  expect(await call('revision.write', note)).toMatchObject({ ok: true });
});

it('re-recording the same URL and page replaces its text, so the old quote no longer verifies', async () => {
  const { call, stored } = await setup();
  const first = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: 'Old synthetic sentence.', page: 2 });
  const replaced = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: 'New synthetic sentence.', page: 2 });
  expect(replaced.data.sourceItemId).toBe(first.data.sourceItemId);
  expect(stored()).toHaveLength(1);
  expect(stored()[0]!.text).toBe('New synthetic sentence.');
  const claims = [{ text: 'Old claim.', citations: [{ sourceItemId: first.data.sourceItemId, quote: 'Old synthetic sentence.', locator: 'page:2' }] }];
  expect(await call('revision.write', { courseId: 'c', sourceRevision: replaced.data.sourceRevision, claims })).toMatchObject({ ok: false, error: { code: 'CITATION_MISMATCH' } });
});

it.each([
  ['Ed thread', 'https://edstem.org/au/courses/10/discussion/2'],
  ['Canvas discussion', 'https://canvas.lms.unimelb.edu.au/courses/1/discussion_topics/2'],
  ['encoded discussion', 'https://canvas.lms.unimelb.edu.au/courses/1/%64iscussion_topics/2'],
])('Discussion thread: refuses %s and stores nothing', async (_name, url) => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url, title: 'Thread', text: 'Synthetic reply.' }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Discussion') } });
  expect(stored()).toEqual([]);
});

it('Page of another course: refuses an Ed lesson of another course and names the mismatch', async () => {
  const { call, stored } = await setup();
  for (const url of ['https://edstem.org/au/courses/20/lessons/7/slides/1', 'https://canvas.lms.unimelb.edu.au/courses/99/pages/lecture', 'https://edstem.org/au/lessons/7']) {
    expect(await call('source.record', { courseId: 'c', url, title: 'Lesson', text: 'Synthetic lesson.' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('course') } });
  }
  expect(stored()).toEqual([]);
  const recorded = await call('source.record', { courseId: 'c', url: 'https://edstem.org/au/courses/10/lessons/7/slides/1', title: 'Lesson', text: 'Synthetic lesson.' });
  expect(recorded).toMatchObject({ ok: true, data: { locator: 'text', copiedBy: 'agent' } });
  expect(await call('sources.get', { sourceItemId: recorded.data.sourceItemId })).toMatchObject({ ok: true, data: { provenance: 'ed', copiedBy: 'agent' } });
});

it('Off-origin link: refuses with the reason and stores nothing', async () => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url: 'https://example.org/courses/1/files/2', title: 'Elsewhere', text: 'Synthetic.' }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Off-origin') } });
  expect(stored()).toEqual([]);
});

it('refuses page text over 100,000 characters and missing courses', async () => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url: pdfURL, title: 'Big', text: 'x'.repeat(100_001), page: 1 }))
    .toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
  expect(await call('source.record', { courseId: 'missing', url: pdfURL, title: 'Lecture', text: 'Synthetic.' }))
    .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(stored()).toEqual([]);
  expect(await call('source.record', { courseId: 'c', url: pdfURL, title: 'Max', text: 'x'.repeat(100_000), page: 1 })).toMatchObject({ ok: true });
});

it('redacts emails and student numbers in agent text before storing', async () => {
  const { call, stored } = await setup();
  const result = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: 'Contact synthetic@example.org. student id: 1234567', page: 1 });
  expect(result).toMatchObject({ ok: true });
  expect(stored()[0]!.text).toContain('[redacted]');
  expect(JSON.stringify(stored())).not.toMatch(/synthetic@example.org|1234567/);
});

it('stores an empty page as empty and reports it without evidence', async () => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: '   ', page: 4 }))
    .toMatchObject({ ok: true, data: { empty: true } });
  expect(stored()).toEqual([expect.objectContaining({ text: '', copiedBy: 'agent' })]);
  const empty = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: '', page: 4 });
  expect(await call('sources.get', { sourceItemId: empty.data.sourceItemId })).toMatchObject({ ok: false });
  expect((await call('revision.read', { courseId: 'c' })).data.sourceRevision).toBe(empty.data.sourceRevision);
});

it('is registered as an agent command', async () => {
  const { agent } = await setup();
  const names = agent.registry.list().map(entry => entry.name);
  expect(names).toContain('source.record');
});
