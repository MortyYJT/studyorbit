import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { dispatch } from '../../src/protocol/registry.js';
import { MAX_RECORDED_BYTES } from '../../src/revision/source-record.js';

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

it('accepts pages whose names only contain auth or token words, and refuses authentication paths and credential queries', async () => {
  const { call, stored } = await setup();
  for (const page of ['authentication-basics', 'tokenizers'])
    expect(await call('source.record', { courseId: 'c', url: `https://canvas.lms.unimelb.edu.au/courses/1/pages/${page}`, title: page, text: 'Synthetic.' }), page).toMatchObject({ ok: true });
  for (const url of ['https://canvas.lms.unimelb.edu.au/courses/1/login', 'https://canvas.lms.unimelb.edu.au/courses/1/auth/saml',
    'https://canvas.lms.unimelb.edu.au/courses/1/pages/x?token=secret', 'https://edstem.org/au/courses/10/lessons/1#access_token=x'])
    expect(await call('source.record', { courseId: 'c', url, title: 'x', text: 'Synthetic.' }), url).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Authentication') } });
  expect(stored()).toHaveLength(2);
});

it('binds the course on the raw path and refuses Canvas announcements like discussions', async () => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url: 'https://canvas.lms.unimelb.edu.au/courses/1%2F..%2F..%2Fcourses%2F99/pages/lecture', title: 'x', text: 'Synthetic.' }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('course') } });
  for (const url of ['https://canvas.lms.unimelb.edu.au/courses/1/announcements/2', 'https://canvas.lms.unimelb.edu.au/api/v1/courses/1/announcements'])
    expect(await call('source.record', { courseId: 'c', url, title: 'x', text: 'Synthetic.' }), url).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Announcements') } });
  expect(stored()).toEqual([]);
});

it('Off-origin link: refuses with the reason and stores nothing', async () => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url: 'https://example.org/courses/1/files/2', title: 'Elsewhere', text: 'Synthetic.' }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('Off-origin') } });
  expect(stored()).toEqual([]);
});

it('bounds a page by its encoded size so the largest recorded page reads back through sources.get', async () => {
  const { call, stored } = await setup();
  const encoded = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
  // Worst cases at the bound: escaped newlines, three-byte CJK text, and the longest accepted URL.
  const longURL = `https://canvas.lms.unimelb.edu.au/courses/1/files/2/${'a'.repeat(2048 - 52)}`;
  expect(longURL.length).toBe(2048);
  const cases = [['x'.repeat(MAX_RECORDED_BYTES), pdfURL], ['a\n'.repeat(MAX_RECORDED_BYTES / 3), pdfURL],
    ['课'.repeat(MAX_RECORDED_BYTES / 3), pdfURL], ['y'.repeat(MAX_RECORDED_BYTES), longURL]] as const;
  for (const [index, [text, url]] of cases.entries()) {
    expect(encoded(text)).toBe(MAX_RECORDED_BYTES);
    const recorded = await call('source.record', { courseId: 'c', url, title: 'Max', text: `${text}`, page: index + 1 });
    expect(recorded).toMatchObject({ ok: true, data: { empty: false } });
    const read = await call('sources.get', { sourceItemId: recorded.data.sourceItemId });
    expect(read, `case ${index}`).toMatchObject({ ok: true, data: { copiedBy: 'agent' } });
    expect(read.data.text.trim().length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(64 * 1024);
  }
  const before = stored().length;
  const over = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Big', text: '课'.repeat(MAX_RECORDED_BYTES / 3 + 1), page: 9 });
  expect(over).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED', retryable: false, message: expect.stringMatching(/bytes.*parts/) } });
  expect(stored()).toHaveLength(before);
  expect(await call('source.record', { courseId: 'missing', url: pdfURL, title: 'Lecture', text: 'Synthetic.' }))
    .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
});

it('redacts emails and student numbers in agent text before storing', async () => {
  const { call, stored } = await setup();
  const result = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: 'Contact synthetic@example.org. student id: 1234567', page: 1 });
  expect(result).toMatchObject({ ok: true });
  expect(stored()[0]!.text).toContain('[redacted]');
  expect(JSON.stringify(stored())).not.toMatch(/synthetic@example.org|1234567/);
});

it.each([
  ['a comparison', 'if a < b then swap a > c', 'if a < b then swap a > c'],
  ['student learning outcomes', 'The student learning outcomes are listed.', 'The student learning outcomes are listed.'],
  ['user interface', 'user interface design', 'user interface design'],
  ['soft hyphens and zero-width spaces', 'recur\u00ADsion and base\u200Bcase', 'recursion and basecase'],
])('stores ordinary lecture text with %s and reads it back', async (_name, text, expected) => {
  const { call } = await setup();
  const recorded = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text, page: 1 });
  expect(recorded).toMatchObject({ ok: true, data: { empty: false } });
  expect(await call('sources.get', { sourceItemId: recorded.data.sourceItemId })).toMatchObject({ ok: true, data: { text: expected, copiedBy: 'agent' } });
  // Study writes keep the strict model-output check, so only quotes it accepts can cite (here: the cleaned text).
  if (!/[<>]|student|user/.test(expected)) expect(await call('revision.write', { courseId: 'c', sourceRevision: recorded.data.sourceRevision,
    claims: [{ text: 'Synthetic claim.', citations: [{ sourceItemId: recorded.data.sourceItemId, quote: expected, locator: 'page:1' }] }] })).toMatchObject({ ok: true });
});

it('masks a classmate email and refuses what the privacy check cannot make safe, without a retry hint', async () => {
  const { call, stored } = await setup();
  expect(await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: 'Ask your classmate fictional.peer@example.org for notes.', page: 1 })).toMatchObject({ ok: true });
  expect(stored()[0]!.text).toBe('Ask your classmate [redacted] for notes.');
  const refused = await call('source.record', { courseId: 'c', url: pdfURL, title: 'Lecture', text: 'Use Authorization: Bearer abc123 for the API.', page: 2 });
  expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', retryable: false, message: expect.stringContaining('privacy check cannot make safe') } });
  expect(stored()).toHaveLength(1);
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
