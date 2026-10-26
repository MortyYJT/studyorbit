import { createHash } from 'node:crypto';
import type { SyncConflict } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import type { CompleteResolvedChoices, GradingConflict } from './grading.js';

export type FoundConflict = GradingConflict;

export interface ReconcileResult {
  /** The course's rows after this check, newest first; never deleted. */
  conflicts: SyncConflict[];
  /** The owner's resolved choices, ready to pass back to `gradeItems`. */
  resolved: CompleteResolvedChoices;
}

/** One id per (course, field, target), so a later sync updates the same row. */
export function conflictId(courseId: string, field: SyncConflict['field'], target: string): string {
  const digest = createHash('sha256').update(`${courseId}\u0000${field}\u0000${target}`).digest('hex');
  return `sync-conflict:${digest}`;
}

function targetOf(conflict: FoundConflict): string {
  return conflict.field === 'weight' ? conflict.componentKey : conflict.canvasAssignmentId;
}

function row(conflict: FoundConflict, id: string, courseId: string, checkedAt: string): SyncConflict {
  if (conflict.field === 'weight') {
    return { id, courseId, field: 'weight', target: { componentKey: conflict.componentKey },
      skeletonValue: conflict.skeletonValue, canvasValue: conflict.canvasValue, state: 'open', checkedAt };
  }
  return { id, courseId, field: 'unmatched', target: { canvasAssignmentId: conflict.canvasAssignmentId },
    canvasValue: conflict.canvasValue, state: 'open', checkedAt };
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** A conflict settled by the owner: its choice is applied by `gradeItems` until its values change. */
export function resolvedChoices(conflicts: readonly SyncConflict[]): CompleteResolvedChoices {
  const resolved: CompleteResolvedChoices = { weight: {}, unmatched: {} };
  for (const conflict of conflicts) {
    if (conflict.state !== 'resolved' || conflict.choice === undefined) continue;
    if (conflict.field === 'weight') {
      const target = conflict.target.componentKey;
      if (target && (conflict.choice === 'skeleton' || conflict.choice === 'canvas')) resolved.weight[target] = conflict.choice;
    } else {
      const target = conflict.target.canvasAssignmentId;
      if (target) resolved.unmatched[target] = conflict.choice;
    }
  }
  return resolved;
}

/**
 * Upsert the conflicts one grading pass found. A conflict found again stays or becomes `open`; a `resolved` row
 * stays resolved while both values are unchanged and reopens when either changes; an `open` row that is no longer
 * found has agreed and becomes `agreed` only when `complete` says the Canvas side was fully captured. Rows are never
 * deleted, so the owner can still see how a value was settled. The whole pass is one transaction: a failing write
 * leaves no half-written rows.
 */
export function reconcileConflicts(store: SqliteRepository, courseId: string, found: readonly FoundConflict[],
  now: string, complete: boolean): ReconcileResult {
  return store.transaction(() => {
    const foundIds = new Set<string>();
    for (const conflict of found) {
      const id = conflictId(courseId, conflict.field, targetOf(conflict));
      foundIds.add(id);
      const existing = store.loadSyncConflict(id);
      if (!existing) {
        store.saveSyncConflict(row(conflict, id, courseId, now));
        continue;
      }
      const unchanged = same(existing.skeletonValue, conflict.field === 'weight' ? conflict.skeletonValue : undefined)
        && same(existing.canvasValue, conflict.canvasValue);
      if (existing.state === 'resolved' && unchanged) {
        store.saveSyncConflict({ ...existing, checkedAt: now });
      } else if (existing.state === 'open' && unchanged) {
        store.saveSyncConflict({ ...existing, checkedAt: now });
      } else {
        // A new, changed or previously agreed conflict is open again; any old choice no longer applies.
        store.saveSyncConflict(row(conflict, id, courseId, now));
      }
    }

    // An open disagreement the new values no longer show has been settled by the platform or the skeleton.
    for (const existing of store.listSyncConflicts(courseId)) {
      if (complete && existing.state === 'open' && !foundIds.has(existing.id)) {
        store.saveSyncConflict({ ...existing, state: 'agreed', checkedAt: now });
      }
    }

    const conflicts = store.listSyncConflicts(courseId);
    return { conflicts, resolved: resolvedChoices(conflicts) };
  });
}
