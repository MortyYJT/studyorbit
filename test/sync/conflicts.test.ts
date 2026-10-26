import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const first = reconcileConflicts(store, courseId, [weight(30, 40)], at, true);
    expect(first.conflicts).toHaveLength(1);
    const row = store.listSyncConflicts(courseId)[0]!;
    expect(row).toMatchObject({ field: 'weight', target: { componentKey: key }, skeletonValue: 30, canvasValue: 40,
      state: 'open', checkedAt: at });
    expect(row).not.toHaveProperty('choice');
    expect(first.resolved).toEqual({ weight: {}, unmatched: {} });

    const second = reconcileConflicts(store, courseId, [weight(30, 40)], later, true);
    expect(store.listSyncConflicts(courseId)).toHaveLength(1);
    expect(store.loadSyncConflict(row.id)).toMatchObject({ id: row.id, state: 'open', checkedAt: later });
    expect(second.conflicts.map(conflict => conflict.id)).toEqual([row.id]);

    const agreed = reconcileConflicts(store, courseId, [], later, true);
    expect(store.loadSyncConflict(row.id)).toMatchObject({ id: row.id, state: 'agreed', checkedAt: later });
    expect(store.listSyncConflicts(courseId)).toHaveLength(1);
    expect(agreed.conflicts[0]).toMatchObject({ id: row.id, state: 'agreed' });
    expect(agreed.resolved).toEqual({ weight: {}, unmatched: {} });
  });

  it('keeps a resolved row with unchanged values, returns its choice, and reopens it when either value changes', () => {
    const store = setup();
    const first = reconcileConflicts(store, courseId, [weight(30, 40)], at, true);
    const row = first.conflicts[0]!;
    store.saveSyncConflict({ ...row, state: 'resolved', choice: 'skeleton', resolvedAt: at });

    const stable = reconcileConflicts(store, courseId, [weight(30, 40)], later, true);
    expect(stable.conflicts).toHaveLength(1);
    expect(store.loadSyncConflict(row.id)).toMatchObject({ state: 'resolved', choice: 'skeleton', resolvedAt: at, checkedAt: later });
    expect(stable.resolved).toEqual({ weight: { [key]: 'skeleton' }, unmatched: {} });
    expect(resolvedChoices(store.listSyncConflicts(courseId))).toEqual(stable.resolved);

    const changed = reconcileConflicts(store, courseId, [weight(30, 45)], later, true);
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
    const first = reconcileConflicts(store, courseId, [unmatched], at, true);
    const row = first.conflicts[0]!;
    expect(row).toMatchObject({ field: 'unmatched', target: { canvasAssignmentId: '700006' }, state: 'open',
      canvasValue: unmatched.canvasValue });
    expect(row).not.toHaveProperty('skeletonValue');
    store.saveSyncConflict({ ...row, state: 'resolved', choice: 'dismissed', resolvedAt: at });
    const stable = reconcileConflicts(store, courseId, [unmatched], later, true);
    expect(stable.conflicts).toHaveLength(1);
    expect(stable.resolved).toEqual({ weight: {}, unmatched: { '700006': 'dismissed' } });
  });

  it('rolls back every write when one upsert fails, leaving no half-done rows', () => {
    const store = setup();
    const original = store.saveSyncConflict.bind(store);
    let writes = 0;
    vi.spyOn(store, 'saveSyncConflict').mockImplementation(conflict => {
      writes += 1;
      if (writes === 2) throw new Error('synthetic write failure');
      original(conflict);
    });
    const unmatched: FoundConflict = { field: 'unmatched', canvasAssignmentId: '700006',
      canvasValue: { id: '700006', name: 'Synthetic Report', due: null } };
    expect(() => reconcileConflicts(store, courseId, [weight(30, 40), unmatched], at, true))
      .toThrow('synthetic write failure');
    expect(store.listSyncConflicts(courseId)).toEqual([]);
  });

  it('keeps an open conflict open when the Canvas side was not fully captured, while still upserting new conflicts', () => {
    const store = setup();
    const first = reconcileConflicts(store, courseId, [weight(30, 40)], at, true);
    const open = first.conflicts[0]!;
    expect(open).toMatchObject({ state: 'open' });

    const partial = reconcileConflicts(store, courseId, [], later, false);
    expect(store.loadSyncConflict(open.id)).toMatchObject({ id: open.id, state: 'open', canvasValue: 40 });
    expect(partial.conflicts[0]).toMatchObject({ id: open.id, state: 'open' });
    expect(partial.resolved).toEqual({ weight: {}, unmatched: {} });

    const unmatched: FoundConflict = { field: 'unmatched', canvasAssignmentId: '700006',
      canvasValue: { id: '700006', name: 'Synthetic Report', due: null } };
    const added = reconcileConflicts(store, courseId, [unmatched], later, false);
    expect(added.conflicts.find(conflict => conflict.field === 'unmatched')).toMatchObject({ state: 'open' });
    expect(store.loadSyncConflict(open.id)).toMatchObject({ state: 'open' });
  });
});
