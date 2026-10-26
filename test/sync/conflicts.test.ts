import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { reconcileConflicts, resolvedChoices, type FoundConflict } from '../../src/sync/conflicts.js';

const stores: SqliteRepository[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new SqliteRepository(':memory:');
  stores.push(store);
  return store;
}

const courseId = 'course:synthetic';
const key = 'ABCD10001:assignments';
const at = '2026-10-24T00:00:00Z';
const later = '2026-10-25T00:00:00Z';
const weight = (skeletonValue: number, canvasValue: number): FoundConflict =>
  ({ field: 'weight', componentKey: key, skeletonValue, canvasValue });

describe('sync conflict reconciliation (layered-sync task 6.1)', () => {
  it('keeps one deterministic row: open stays open, then open becomes agreed when the values agree, without deleting', () => {
    const store = setup();
    const first = reconcileConflicts(store, courseId, [weight(30, 40)], at);
    expect(first.conflicts).toHaveLength(1);
    const row = store.listSyncConflicts(courseId)[0]!;
    expect(row).toMatchObject({ field: 'weight', target: { componentKey: key }, skeletonValue: 30, canvasValue: 40,
      state: 'open', checkedAt: at });
    expect(row).not.toHaveProperty('choice');
    expect(first.resolved).toEqual({ weight: {}, unmatched: {} });

    const second = reconcileConflicts(store, courseId, [weight(30, 40)], later);
    expect(store.listSyncConflicts(courseId)).toHaveLength(1);
    expect(store.loadSyncConflict(row.id)).toMatchObject({ id: row.id, state: 'open', checkedAt: later });
    expect(second.conflicts.map(conflict => conflict.id)).toEqual([row.id]);

    const agreed = reconcileConflicts(store, courseId, [], later);
    expect(store.loadSyncConflict(row.id)).toMatchObject({ id: row.id, state: 'agreed', checkedAt: later });
    expect(store.listSyncConflicts(courseId)).toHaveLength(1);
    expect(agreed.conflicts[0]).toMatchObject({ id: row.id, state: 'agreed' });
    expect(agreed.resolved).toEqual({ weight: {}, unmatched: {} });
  });

  it('keeps a resolved row with unchanged values, returns its choice, and reopens it when either value changes', () => {
    const store = setup();
    const first = reconcileConflicts(store, courseId, [weight(30, 40)], at);
    const row = first.conflicts[0]!;
    store.saveSyncConflict({ ...row, state: 'resolved', choice: 'skeleton', resolvedAt: at });

    const stable = reconcileConflicts(store, courseId, [weight(30, 40)], later);
    expect(stable.conflicts).toHaveLength(1);
    expect(store.loadSyncConflict(row.id)).toMatchObject({ state: 'resolved', choice: 'skeleton', resolvedAt: at, checkedAt: later });
    expect(stable.resolved).toEqual({ weight: { [key]: 'skeleton' }, unmatched: {} });
    expect(resolvedChoices(store.listSyncConflicts(courseId))).toEqual(stable.resolved);

    const changed = reconcileConflicts(store, courseId, [weight(30, 45)], later);
    expect(store.listSyncConflicts(courseId)).toHaveLength(1);
    const reopened = store.loadSyncConflict(row.id)!;
    expect(reopened).toMatchObject({ id: row.id, state: 'open', skeletonValue: 30, canvasValue: 45, checkedAt: later });
    expect(reopened).not.toHaveProperty('choice');
    expect(reopened).not.toHaveProperty('resolvedAt');
    expect(changed.resolved).toEqual({ weight: {}, unmatched: {} });
  });

  it('gives an unmatched conflict its own deterministic id and returns a resolved component or dismissal', () => {
    const store = setup();
    const unmatched: FoundConflict = { field: 'unmatched', canvasAssignmentId: '700006',
      canvasValue: { id: '700006', name: 'Synthetic Report', due: '2026-11-07T12:59:00Z' } };
    const first = reconcileConflicts(store, courseId, [unmatched], at);
    const row = first.conflicts[0]!;
    expect(row).toMatchObject({ field: 'unmatched', target: { canvasAssignmentId: '700006' }, state: 'open',
      canvasValue: unmatched.canvasValue });
    expect(row).not.toHaveProperty('skeletonValue');
    store.saveSyncConflict({ ...row, state: 'resolved', choice: 'dismissed', resolvedAt: at });
    const stable = reconcileConflicts(store, courseId, [unmatched], later);
    expect(stable.conflicts).toHaveLength(1);
    expect(stable.resolved).toEqual({ weight: {}, unmatched: { '700006': 'dismissed' } });
  });
});
