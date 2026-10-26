import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch, isOwnerCommand } from '../../src/protocol/registry.js';
import { ownerCommands } from '../../src/protocol/contracts.js';
import { reconcileConflicts, type FoundConflict } from '../../src/sync/conflicts.js';
import { gradeItems } from '../../src/sync/grading.js';
import type { GroupsStage } from '../../src/sync/canvas-api.js';
import type { SkeletonStage } from '../../src/sync/handbook.js';
import type { ItemsClassifyInput } from '../../src/protocol/sync.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const courseId = 'course:synthetic';
const courseCode = 'SYNA10001';
const key = `${courseCode}:assignments`;
const at = '2026-10-24T00:00:00Z';
const source = 'https://canvas.lms.unimelb.edu.au/api/v1/courses/900001/assignment_groups';

function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'check-resolve-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveCourse({ id: courseId, moduleId: 'synthetic-module', code: courseCode, name: 'Synthetic Systems',
    term: '2026:S2', assessmentsComplete: false });
  const agent = host.registry.agentTools(host.context);
  const ownerCall = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  return { store, host, ownerCall, agentCall };
}

const data = <T>(envelope: { ok: boolean }) => (envelope as unknown as { data: T }).data;

function canvasGroups(weight: number): GroupsStage {
  const group = { id: '501', name: 'Synthetic Assignments', weight: { value: weight, state: 'found' as const, via: 'api' as const, source } };
  return { source, via: 'api', coverage: 'api', unweighted: weight === 0, groups: [{ ...group, assignments: [{
    id: '700001', name: 'Synthetic Assignment 1', courseId: '900001', assignmentGroupId: '501', group,
    due: { value: '2026-10-31T12:59:00Z', state: 'found' as const, via: 'api' as const, source },
    unlockAt: { value: '2026-10-01T00:00:00Z', state: 'found' as const, via: 'api' as const, source },
    outOf: { value: 20, state: 'found' as const, via: 'api' as const, source },
    score: { value: null, state: 'unknown' as const, checkedAt: at },
    status: { value: 'not_started' as const, state: 'found' as const, via: 'api' as const, source },
    updatedAt: { value: '2026-10-20T08:00:00Z', state: 'found' as const, via: 'api' as const, source },
  }] }] };
}
const skeleton: SkeletonStage = { source: 'https://handbook.unimelb.edu.au/2026/subjects/syna10001/assessment', via: 'handbook',
  components: [{ name: 'Assignments', weight: 30, quote: 'Assignments\tWeeks 3-10\t30%' }] };
const classification: ItemsClassifyInput = { jobId: 'synthetic-job', courseKey: `${courseCode}:2026:S2`,
  items: [{ id: '700001', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }] };
const gradeInput = { courseCode, groups: canvasGroups(40), skeleton, classification };

describe('check.resolve owner command (layered-sync task 6.1)', () => {
  it('Owner keeps the Handbook weight: resolving with skeleton stores the choice and the next gradeItems uses 30', async () => {
    const f = setup();
    const before = gradeItems(gradeInput);
    const reconciled = reconcileConflicts(f.store, courseId, before.conflicts, at);
    const open = reconciled.conflicts[0]!;
    expect(open).toMatchObject({ field: 'weight', state: 'open', skeletonValue: 30, canvasValue: 40 });

    const resolved = await f.ownerCall('check.resolve', { conflictId: open.id, choice: 'skeleton' });
    expect(resolved).toMatchObject({ ok: true });
    const result = data<{ conflict: Record<string, unknown>; choices: { weight: Record<string, 'skeleton' | 'canvas'>; unmatched: Record<string, string> } }>(resolved);
    expect(result.conflict).toMatchObject({ id: open.id, state: 'resolved', choice: 'skeleton', resolvedAt: expect.any(String) });
    expect(f.store.loadSyncConflict(open.id)).toMatchObject({ state: 'resolved', choice: 'skeleton' });
    expect(result.choices.weight).toEqual({ [key]: 'skeleton' });

    const after = gradeItems({ ...gradeInput, resolved: result.choices });
    expect(after.items[0]).toMatchObject({ componentKey: key, effectiveComponentWeight: 30 });
  });

  it('accepts an unmatched component key of the same course and dismissed, and returns the choices', async () => {
    const f = setup();
    const found: FoundConflict = { field: 'unmatched', canvasAssignmentId: '700001',
      canvasValue: { id: '700001', name: 'Synthetic Assignment 1', due: '2026-10-31T12:59:00Z' } };
    const row = reconcileConflicts(f.store, courseId, [found], at).conflicts[0]!;
    const assigned = await f.ownerCall('check.resolve', { conflictId: row.id, choice: key });
    expect(assigned).toMatchObject({ ok: true });
    expect(data<{ conflict: Record<string, unknown> }>(assigned).conflict).toMatchObject({ state: 'resolved', choice: key });

    const second = reconcileConflicts(f.store, courseId, [found], at).conflicts[0]!;
    const dismissed = await f.ownerCall('check.resolve', { conflictId: second.id, choice: 'dismissed' });
    expect(dismissed).toMatchObject({ ok: true });
    expect(data<{ choices: { unmatched: Record<string, string> } }>(dismissed).choices.unmatched).toEqual({ '700001': 'dismissed' });
  });

  it('refuses a wrong choice for the field, an unknown id, an agreed conflict and another course component key', async () => {
    const f = setup();
    const weight = reconcileConflicts(f.store, courseId, [{ field: 'weight', componentKey: key, skeletonValue: 30, canvasValue: 40 }], at).conflicts[0]!;
    expect(await f.ownerCall('check.resolve', { conflictId: weight.id, choice: 'dismissed' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await f.ownerCall('check.resolve', { conflictId: 'synthetic-missing', choice: 'skeleton' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await f.ownerCall('check.resolve', { conflictId: weight.id, choice: 'skeleton' })).toMatchObject({ ok: true });

    const unmatched = reconcileConflicts(f.store, courseId, [{ field: 'unmatched', canvasAssignmentId: '700001',
      canvasValue: { id: '700001', name: 'Synthetic Assignment 1', due: null } }], at).conflicts[0]!;
    expect(await f.ownerCall('check.resolve', { conflictId: unmatched.id, choice: 'SYNB20002:assignments' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    f.store.saveSyncConflict({ id: 'synthetic-agreed', courseId, target: { componentKey: key }, field: 'weight',
      skeletonValue: 30, canvasValue: 30, state: 'agreed', checkedAt: at });
    expect(await f.ownerCall('check.resolve', { conflictId: 'synthetic-agreed', choice: 'canvas' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('is owner-only: absent from the agent tool set and refused from the agent context', async () => {
    const f = setup();
    expect(ownerCommands.has('check.resolve')).toBe(true);
    expect(isOwnerCommand('check.resolve')).toBe(true);
    const names = f.host.registry.agentTools(f.host.context).registry.list().map(entry => entry.name);
    expect(names).not.toContain('check.resolve');
    const agent = f.agentCall('check.resolve', { conflictId: 'synthetic-missing', choice: 'skeleton' });
    expect(await agent).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const { owner: _owner, ...anonymous } = f.host.context;
    expect(await dispatch(f.host.registry, 'check.resolve', { conflictId: 'synthetic-missing', choice: 'skeleton' }, anonymous))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
