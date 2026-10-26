import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch, isOwnerCommand } from '../../src/protocol/registry.js';
import { createMcpServer } from '../../src/protocol/mcp.js';
import { reconcileConflicts } from '../../src/sync/conflicts.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const course = { id: 'course:synthetic', moduleId: 'synthetic-module', code: 'SYNA10001', name: 'Synthetic Systems',
  term: '2026:S2', assessmentsComplete: true };
const assessment = { id: 'assessment:synthetic', courseId: course.id, name: 'Synthetic Report', kind: 'assignment' as const,
  weight: 30, isFinal: false, status: 'not_started' as const, unlockAt: '2026-10-01T00:00:00Z' };
const key = `${course.code}:assignments`;
const currentPath = join('assessments', 'Synthetic Report', 'instructions.html');
const supersededPath = join('assessments', 'Synthetic Report', 'instructions (2026-10-20).html');

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'layered-sync-needs-you-')));
  const root = join(base, 'Desktop');
  const store = new SqliteRepository(':memory:');
  const opened: string[] = [];
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(base, 'journal')),
    courseFolder: { root }, fileOpener: async path => { opened.push(path); }, owner: { assertOwner: async () => {} } });
  cleanups.push(async () => { store.close(); rmSync(base, { recursive: true, force: true }); });
  store.saveCourse(course);
  store.saveAssessment(assessment);
  const call = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const folder = join(root, 'UniMelb 26S2', course.name);
  return { base, root, store, host, opened, call, folder };
}

function data<T>(envelope: { ok: boolean; data?: unknown }): T {
  if (!envelope.ok) throw new Error(`read failed: ${JSON.stringify(envelope)}`);
  return envelope.data as T;
}

function seedUpdatedFile(f: ReturnType<typeof setup>) {
  const current = join(f.folder, currentPath);
  const previous = join(f.folder, supersededPath);
  mkdirSync(dirname(current), { recursive: true });
  writeFileSync(current, 'current synthetic instructions');
  writeFileSync(previous, 'previous synthetic instructions');
  f.store.saveSavedFile({ id: 'saved-old', courseId: course.id, assessmentId: assessment.id, path: supersededPath,
    fingerprint: 'a'.repeat(64), savedAt: '2026-10-20T00:00:00Z', supersededAt: '2026-10-23T00:00:00Z' });
  f.store.saveSavedFile({ id: 'saved-current', courseId: course.id, assessmentId: assessment.id, path: currentPath,
    fingerprint: 'b'.repeat(64), savedAt: '2026-10-23T00:00:00Z' });
  return { current, previous };
}

type AssessmentItem = { id: string; unlockAt?: string; savedFiles?: { id: string; name: string; current: boolean; updated: boolean;
  savedAt: string; supersededAt?: string; openedAt?: string }[] };
type UpdateItem = { savedFileId: string; courseId: string; assessmentId: string; assessmentName: string; name: string; savedAt: string };
type ConflictItem = { id: string; field: string; componentName?: string; canvasName?: string;
  components?: { key: string; name: string }[]; choice?: string; resolvedAt?: string };

describe('layered-sync 9.2-9.3 reads and file.open (issue #225)', () => {
  it('lists an assessment with its superseded and current saved files, current first and only the current one updated', async () => {
    const f = setup();
    seedUpdatedFile(f);
    const list = data<{ items: AssessmentItem[] }>(await f.call('assessments.list', { courseId: course.id }));
    const item = list.items.find(candidate => candidate.id === assessment.id)!;
    expect(item.unlockAt).toBe(assessment.unlockAt);
    expect(item.savedFiles).toHaveLength(2);
    expect(item.savedFiles!.map(file => file.id)).toEqual(['saved-current', 'saved-old']);
    expect(item.savedFiles![0]).toMatchObject({ name: 'instructions.html', current: true, updated: true,
      savedAt: '2026-10-23T00:00:00Z' });
    expect(item.savedFiles![1]).toMatchObject({ name: 'instructions (2026-10-20).html', current: false, updated: false,
      supersededAt: '2026-10-23T00:00:00Z' });
    // The stored relative path and the absolute course folder never reach the read.
    expect(JSON.stringify(item.savedFiles)).not.toContain('assessments/');
    expect(JSON.stringify(item.savedFiles)).not.toContain(f.base);
  });

  it('opens the current file, records openedAt, clears updated and removes the update notice', async () => {
    const f = setup();
    const { current } = seedUpdatedFile(f);
    const before = data<{ items: UpdateItem[] }>(await f.call('updates.list', { limit: 10 }));
    expect(before.items).toContainEqual(expect.objectContaining({ savedFileId: 'saved-current', courseId: course.id,
      assessmentId: assessment.id, assessmentName: assessment.name, name: 'instructions.html', savedAt: '2026-10-23T00:00:00Z' }));

    const opened = data<{ opened: true; openedAt: string }>(await f.call('file.open', { savedFileId: 'saved-current' }));
    expect(opened).toMatchObject({ opened: true, openedAt: expect.any(String) });
    expect(f.opened).toEqual([current]);
    expect(f.store.loadSavedFile('saved-current')).toMatchObject({ openedAt: opened.openedAt });

    const list = data<{ items: AssessmentItem[] }>(await f.call('assessments.list', { courseId: course.id }));
    const item = list.items.find(candidate => candidate.id === assessment.id)!;
    expect(item.savedFiles!.find(file => file.id === 'saved-current')).toMatchObject({ openedAt: opened.openedAt, updated: false });
    const after = data<{ items: UpdateItem[] }>(await f.call('updates.list', { limit: 10 }));
    expect(after.items.map(notice => notice.savedFileId)).not.toContain('saved-current');
  });

  it('refuses unknown, escaping, missing and non-regular files without opening, and stays out of agent and MCP tools', async () => {
    const f = setup();
    const outside = join(f.base, 'outside.html');
    writeFileSync(outside, 'outside the course folder');
    mkdirSync(join(f.folder, 'assessments', 'Directory'), { recursive: true });
    const record = { courseId: course.id, assessmentId: assessment.id, fingerprint: 'c'.repeat(64), savedAt: '2026-10-23T00:00:00Z' };
    f.store.saveSavedFile({ ...record, id: 'saved-escape', path: outside });
    f.store.saveSavedFile({ ...record, id: 'saved-missing', path: join('assessments', 'Missing', 'instructions.html') });
    f.store.saveSavedFile({ ...record, id: 'saved-directory', path: join('assessments', 'Directory') });

    for (const [savedFileId, code] of [['saved-unknown', 'NOT_FOUND'], ['saved-escape', 'INVALID_INPUT'],
      ['saved-missing', 'NOT_FOUND'], ['saved-directory', 'INVALID_INPUT']] as const) {
      const refused = await f.call('file.open', { savedFileId });
      expect(refused).toMatchObject({ ok: false, error: { code } });
    }
    expect(f.opened).toEqual([]);
    for (const id of ['saved-escape', 'saved-missing', 'saved-directory']) expect(f.store.loadSavedFile(id)?.openedAt).toBeUndefined();

    expect(isOwnerCommand('file.open')).toBe(true);
    const agentNames = f.host.registry.agentTools(f.host.context).registry.list().map(entry => entry.name);
    expect(agentNames).not.toContain('file.open');
    expect(agentNames).toEqual(expect.arrayContaining(['conflicts.list', 'updates.list']));

    const server = createMcpServer({ registry: f.host.registry, context: f.host.context });
    const client = new Client({ name: 'synthetic-needs-you', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const mcpNames = (await client.listTools()).tools.map(tool => tool.name);
    expect(mcpNames).not.toContain('file.open');
    expect(mcpNames).toEqual(expect.arrayContaining(['conflicts.list', 'updates.list']));
  });

  it('a course filter never returns another course\'s conflicts, even when the filtered course has none', async () => {
    const f = setup();
    const other = { ...course, id: 'course-other', code: 'SYNB20002', name: 'Other synthetic course' };
    f.store.saveCourse(other);
    reconcileConflicts(f.store, other.id, [{ field: 'weight', componentKey: `${other.code}:assignments`, skeletonValue: 20, canvasValue: 25 }],
      new Date(Date.now() - 60_000).toISOString(), true);
    const filtered = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { courseId: course.id, state: 'open', limit: 10 }));
    expect(filtered.items).toEqual([]);
    const everything = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { state: 'open', limit: 10 }));
    expect(everything.items).toHaveLength(1);
  });

  it('offers every graded component of the course for an unmatched conflict, including components stored as items, but not the synthetic ones', async () => {
    const f = setup();
    const group = (key: string, name: string, role: 'item' | 'remainder' | 'component') => ({ key, name, weight: 20, role });
    f.store.saveAssessment({ id: 'item-1', courseId: course.id, name: 'Synthetic Quiz 1', kind: 'quiz', weight: 10, isFinal: false,
      status: 'not_started', group: group(`${course.code}:quizzes`, 'Quizzes', 'item') });
    f.store.saveAssessment({ id: 'rest-1', courseId: course.id, name: 'Labs remainder', kind: 'assignment', weight: 20, isFinal: false,
      status: 'not_started', group: group(`${course.code}:labs`, 'Labs', 'remainder') });
    f.store.saveAssessment({ id: 'ungraded-1', courseId: course.id, name: 'Synthetic survey', kind: 'ungraded', weight: 0, isFinal: false,
      status: 'not_started', group: { key: `${course.code}:ungraded`, name: 'Ungraded', weight: 0, role: 'item' } });
    reconcileConflicts(f.store, course.id, [{ field: 'unmatched', canvasAssignmentId: '700009',
      canvasValue: { id: '700009', name: 'Synthetic Assignment 9', due: null } }], new Date(Date.now() - 60_000).toISOString(), true);
    const open = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { courseId: course.id, state: 'open', limit: 10 }));
    expect(open.items[0]!.components!.map(component => component.key).sort()).toEqual([`${course.code}:labs`, `${course.code}:quizzes`]);
  });

  it('lists weight and unmatched conflicts with display names, hides a resolved conflict as open, and shows it in all', async () => {
    const f = setup();
    f.store.saveAssessment({ id: 'component:assignments', courseId: course.id, name: 'Assignments', kind: 'assignment',
      weight: 40, isFinal: false, status: 'not_started', group: { key, name: 'Assignments', weight: 40, role: 'component' } });
    f.store.saveAssessment({ id: 'component:quizzes', courseId: course.id, name: 'Quizzes', kind: 'quiz',
      weight: 10, isFinal: false, status: 'not_started', group: { key: `${course.code}:quizzes`, name: 'Quizzes', weight: 10, role: 'component' } });
    const checkedAt = new Date(Date.now() - 60_000).toISOString();
    const rows = reconcileConflicts(f.store, course.id, [
      { field: 'weight', componentKey: key, skeletonValue: 30, canvasValue: 40 },
      { field: 'unmatched', canvasAssignmentId: '700001',
        canvasValue: { id: '700001', name: 'Synthetic Assignment 1', due: null } },
    ], checkedAt, true).conflicts;

    const open = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { courseId: course.id, state: 'open', limit: 10 }));
    expect(open.items).toHaveLength(2);
    expect(open.items.find(item => item.field === 'weight')).toMatchObject({ componentName: 'Assignments',
      target: { componentKey: key }, skeletonValue: 30, canvasValue: 40, state: 'open' });
    expect(open.items.find(item => item.field === 'unmatched')).toMatchObject({ canvasName: 'Synthetic Assignment 1',
      target: { canvasAssignmentId: '700001' }, state: 'open',
      components: expect.arrayContaining([{ key, name: 'Assignments' }, { key: `${course.code}:quizzes`, name: 'Quizzes' }]) });

    const weight = rows.find(row => row.field === 'weight')!;
    expect(await f.call('check.resolve', { conflictId: weight.id, choice: 'canvas' })).toMatchObject({ ok: true });
    const stillOpen = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { courseId: course.id, state: 'open', limit: 10 }));
    expect(stillOpen.items.map(item => item.id)).not.toContain(weight.id);
    const all = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { courseId: course.id, state: 'all', limit: 10 }));
    expect(all.items.find(item => item.id === weight.id)).toMatchObject({ choice: 'canvas', state: 'resolved',
      resolvedAt: expect.any(String) });

    const first = data<{ items: ConflictItem[]; nextCursor?: string }>(await f.call('conflicts.list', { courseId: course.id, state: 'all', limit: 1 }));
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = data<{ items: ConflictItem[] }>(await f.call('conflicts.list', { courseId: course.id, state: 'all', limit: 1, cursor: first.nextCursor }));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  });
});
