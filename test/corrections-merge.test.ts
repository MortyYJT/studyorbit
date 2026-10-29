import { describe, expect, it } from 'vitest';
import { conflictId, mergeCorrections, resolveConflict, type Conflict, type Correction, type Fields } from '../shared/corrections.js';

// Three-way merge scenarios from openspec/changes/archive/2026-10-29-local-corrections-merge (PR 2, tasks 2.1, 2.2 and 2.4). Synthetic data only.
const at = '2026-10-30T02:00:00.000Z';
const fields = (patch: Partial<Fields> = {}): Fields => ({
  name: 'Synthetic', kind: 'assignment', nature: 'regular', weight: 20, score: null, outOf: null, due: '2026-11-03T12:59:00Z',
  status: 'not_started', rule: null, scoring: 'none', parent: null, link: null, ...patch,
});
type State = { corrections: Record<string, Correction>; pins: Record<string, string[]>; conflicts: Conflict[] };
const state = (corrections: Record<string, Correction>, patch: Partial<State> = {}): State & { courseId: string } => ({ courseId: '100', corrections, pins: {}, conflicts: [], ...patch });
const merge = (base: Record<string, Fields>, incoming: Record<string, Fields>, current: State) => mergeCorrections(base, incoming, { courseId: '100', ...current }, at);
const summary = (conflicts: Conflict[]) => conflicts.map(conflict => [conflict.type, conflict.key, conflict.field]);

describe('mergeCorrections', () => {
  it('only the sync changed: the sync value shows and nothing is recorded', () => {
    const result = merge({ a1: fields() }, { a1: fields({ weight: 25 }) }, state({ '100:a1': { name: 'My name' } }));
    expect(result.corrections).toEqual({ '100:a1': { name: 'My name' } });
    expect(result.conflicts).toEqual([]);
    expect(result.pins).toEqual({});
  });

  it('only the owner changed: the owner value is kept with no conflict and no pin', () => {
    const result = merge({ a1: fields() }, { a1: fields() }, state({ '100:a1': { weight: 30 } }));
    expect(result.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(result.conflicts).toEqual([]);
    expect(result.pins).toEqual({});
  });

  it('both changed to the same value: the field is kept and pinned, and an open conflict on it is closed', () => {
    const open: Conflict = { id: conflictId('field', '100:a1', 'weight'), type: 'field', key: '100:a1', assessmentId: 'a1', field: 'weight', base: 20, incoming: 25, user: 30, detectedAt: at };
    const result = merge({ a1: fields() }, { a1: fields({ weight: 30 }) }, state({ '100:a1': { weight: 30 } }, { conflicts: [open] }));
    expect(result.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(result.pins).toEqual({ '100:a1': ['weight'] });
    expect(result.conflicts).toEqual([]);
  });

  it('both changed differently: the owner value is kept and a field conflict records base, sync and owner', () => {
    const result = merge({ a1: fields() }, { a1: fields({ due: '2026-11-10T12:59:00Z' }) }, state({ '100:a1': { due: '2026-11-05T12:59:00Z' } }));
    expect(result.corrections).toEqual({ '100:a1': { due: '2026-11-05T12:59:00Z' } });
    expect(result.conflicts).toEqual([{
      id: conflictId('field', '100:a1', 'due'), type: 'field', key: '100:a1', assessmentId: 'a1', field: 'due',
      base: '2026-11-03T12:59:00Z', incoming: '2026-11-10T12:59:00Z', user: '2026-11-05T12:59:00Z', detectedAt: at,
    }]);
  });

  it('a pinned field that a later sync changes raises a conflict and keeps the owner value', () => {
    const first = merge({ a1: fields() }, { a1: fields({ weight: 30 }) }, state({ '100:a1': { weight: 30 } }));
    const second = merge({ a1: fields({ weight: 30 }) }, { a1: fields({ weight: 25 }) }, first);
    expect(second.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(second.pins).toEqual({ '100:a1': ['weight'] });
    expect(second.conflicts.map(conflict => [conflict.field, conflict.base, conflict.incoming, conflict.user])).toEqual([['weight', 30, 25, 30]]);
    // A pinned value the sync leaves alone stays pinned and quiet.
    const quiet = merge({ a1: fields({ weight: 30 }) }, { a1: fields({ weight: 30, name: 'Renamed' }) }, first);
    expect([quiet.corrections, quiet.pins, quiet.conflicts]).toEqual([{ '100:a1': { weight: 30 } }, { '100:a1': ['weight'] }, []]);
  });

  it('a pinned value the sync moves within the same Melbourne day raises no conflict', () => {
    // A parent form saves date-only dues; the sync converged on that day, then moved the time within it.
    const group = '100:group:100:g1';
    const first = merge({ g1: fields({ due: '2026-11-03T12:59:00Z' }) }, { g1: fields({ due: '2026-11-05T12:59:00Z' }) }, state({ [group]: { due: '2026-11-05' } }));
    expect(first.pins).toEqual({ [group]: ['due'] });
    const second = merge({ g1: fields({ due: '2026-11-05T12:59:00Z' }) }, { g1: fields({ due: '2026-11-05T06:00:00Z' }) }, first);
    expect(second.corrections).toEqual({ [group]: { due: '2026-11-05' } });
    expect(second.conflicts).toEqual([]);
  });

  it('a field the owner left at the base value is dropped so the sync value shows', () => {
    // The edit form resends unchanged fields; one equal to the base is not the owner's change.
    const result = merge({ a1: fields() }, { a1: fields({ weight: 25 }) }, state({ '100:a1': { weight: 20, name: 'Mine' } }));
    expect(result.corrections).toEqual({ '100:a1': { name: 'Mine' } });
    expect(result.conflicts).toEqual([]);
  });

  it('assessment deleted by the sync: the correction is kept and an orphaned conflict is raised on the transition only', () => {
    const result = merge({ a1: fields(), a2: fields() }, { a2: fields() }, state({ '100:a1': { weight: 30, name: 'Mine', due: '2026-11-03T12:59:00Z' } }));
    expect(result.corrections).toEqual({ '100:a1': { weight: 30, name: 'Mine', due: '2026-11-03T12:59:00Z' } });
    expect(summary(result.conflicts)).toEqual([['orphaned', '100:a1', null]]);
    expect(result.conflicts[0]).toMatchObject({ id: conflictId('orphaned', '100:a1', null), assessmentId: 'a1', base: fields(), incoming: null, user: { weight: 30, name: 'Mine', due: '2026-11-03T12:59:00Z' } });
    // 「保留」 closes it; a later sync that still lacks a1 raises nothing.
    const kept = merge({ a2: fields() }, { a2: fields({ weight: 5 }) }, { ...result, conflicts: [] });
    expect(kept.corrections).toEqual(result.corrections);
    expect(kept.conflicts).toEqual([]);
  });

  it('assessment deleted by the sync: a hide-only correction raises nothing', () => {
    const result = merge({ a1: fields(), a2: fields() }, { a1: fields() }, state({ '100:a2': { hidden: true } }));
    expect(result.corrections).toEqual({ '100:a2': { hidden: true } });
    expect(result.conflicts).toEqual([]);
  });

  it('an orphaned conflict closes when the assessment comes back, and its correction is adopted', () => {
    const removed = merge({ a1: fields() }, {}, state({ '100:a1': { weight: 30 } }));
    expect(summary(removed.conflicts)).toEqual([['orphaned', '100:a1', null]]);
    const back = merge({}, { a1: fields({ weight: 25 }) }, removed);
    expect(back.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(back.conflicts).toEqual([]);
  });

  it('parent and mergeInto naming a removed item raise dangling conflicts on the transition only', () => {
    const corrections = { '100:a2': { mergeInto: '100:a1' }, '100:a3': { parent: '100:a1' }, '100:a4': { parent: '100:manual:m1' } };
    const base = { a1: fields(), a2: fields(), a3: fields(), a4: fields() };
    const incoming = { a2: fields(), a3: fields(), a4: fields() };
    const result = merge(base, incoming, state(corrections));
    expect(result.corrections).toEqual(corrections);
    expect(summary(result.conflicts)).toEqual([['dangling', '100:a2', 'mergeInto'], ['dangling', '100:a3', 'parent']]);
    expect(result.conflicts[0]).toMatchObject({ assessmentId: 'a2', user: '100:a1' });
    const again = merge(incoming, incoming, { ...result, conflicts: [] });
    expect(again.conflicts).toEqual([]);
  });

  it('a new assessment without a correction changes nothing', () => {
    const current = state({ '100:a1': { weight: 30 } });
    const result = merge({ a1: fields() }, { a1: fields(), canvas_new: fields({ name: 'New one' }) }, current);
    expect(result).toEqual({ corrections: { '100:a1': { weight: 30 } }, pins: {}, conflicts: [] });
  });

  it('a correction with no base entry is adopted against the incoming value without a conflict', () => {
    const result = merge({}, { a1: fields({ weight: 25, name: 'Synced' }) }, state({ '100:a1': { weight: 30, name: 'Synced' } }));
    expect(result.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(result.conflicts).toEqual([]);
    expect(result.pins).toEqual({});
  });

  it('group corrections are compared with the base of their assessment', () => {
    const group = '100:group:100:g1';
    const result = merge({ g1: fields({ weight: 30, name: 'Quizzes' }) }, { g1: fields({ weight: 35, name: 'All quizzes' }) }, state({ [group]: { weight: 40, name: 'All quizzes', kind: 'quiz' } }));
    expect(result.corrections).toEqual({ [group]: { weight: 40, name: 'All quizzes', kind: 'quiz' } });
    expect(result.pins).toEqual({ [group]: ['name'] });
    expect(summary(result.conflicts)).toEqual([['field', group, 'weight']]);
    expect(result.conflicts[0]).toMatchObject({ assessmentId: 'g1', base: 30, incoming: 35, user: 40 });
  });

  it('link and owner-only fields never conflict', () => {
    const result = merge({ a1: fields({ link: 'https://canvas.example.edu/a' }) }, { a1: fields({ link: 'https://canvas.example.edu/b' }) },
      state({ '100:a1': { link: 'https://example.org/mine', hidden: true, mergeInto: '100:a2', bonus: true } }));
    expect(result.corrections).toEqual({ '100:a1': { link: 'https://example.org/mine', hidden: true, mergeInto: '100:a2', bonus: true } });
    expect(result.conflicts).toEqual([]);
  });

  it('keeps conflict IDs stable across merges and replaces an open conflict instead of duplicating it', () => {
    const first = merge({ a1: fields() }, { a1: fields({ weight: 25 }) }, state({ '100:a1': { weight: 30 } }));
    const second = merge({ a1: fields({ weight: 25 }) }, { a1: fields({ weight: 26 }) }, first);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]).toMatchObject({ id: first.conflicts[0]!.id, base: 25, incoming: 26, user: 30 });
    // A sync that leaves the field alone keeps the open conflict as it is.
    const third = merge({ a1: fields({ weight: 26 }) }, { a1: fields({ weight: 26, name: 'Other' }) }, second);
    expect(third.conflicts).toEqual(second.conflicts);
  });

  it('leaves manual-item corrections and keys of neither form alone', () => {
    const corrections = { '100:manual:m1': { name: 'Manual' }, '100:group:100:manual:m1': { weight: 10 } };
    expect(merge({ a1: fields() }, {}, state(corrections)).corrections).toEqual(corrections);
  });

  it('merging the same document twice changes nothing', () => {
    const first = merge({ a1: fields(), a2: fields() }, { a1: fields({ weight: 25 }) }, state({ '100:a1': { weight: 30, name: 'Mine' }, '100:a2': { name: 'Gone' } }));
    expect(merge({ a1: fields({ weight: 25 }) }, { a1: fields({ weight: 25 }) }, first)).toEqual(first);
  });
});

describe('after re-sync all owner corrections are preserved', () => {
  const base = {
    a1: fields({ name: 'Assignment 1', weight: 20 }),
    a2: fields({ name: 'Assignment 2', weight: 15, score: null, due: '2026-11-03T12:59:00Z' }),
    a3: fields({ name: 'Quiz 1', weight: 5, parent: null }),
    g1: fields({ name: 'Quizzes', weight: 10 }),
    a4: fields({ name: 'Lab', weight: 0 }),
  };
  const corrections: Record<string, Correction> = {
    '100:a1': { name: 'Essay', weight: 25 },
    '100:a2': { due: '2026-11-05T12:59:00Z', score: 12 },
    '100:a3': { parent: '100:g1' },
    '100:group:100:g1': { weight: 12 },
    '100:a4': { hidden: true },
  };
  // What the page shows: the correction field when set, otherwise the synced value.
  const effective = (merged: { corrections: Record<string, Correction> }, incoming: Record<string, Fields>, key: string, field: string) => {
    const correction = merged.corrections[key] as Record<string, unknown> | undefined;
    if (correction && correction[field] !== undefined) return correction[field];
    const id = key.startsWith('100:group:100:') ? key.slice('100:group:100:'.length) : key.slice('100:'.length);
    return (incoming[id] as Record<string, unknown> | undefined)?.[field];
  };
  const expectOwnerValues = (merged: { corrections: Record<string, Correction> }, incoming: Record<string, Fields>) => {
    for (const [key, correction] of Object.entries(corrections)) {
      for (const [field, value] of Object.entries(correction)) expect([key, field, effective(merged, incoming, key, field)]).toEqual([key, field, value]);
    }
  };

  it('keeps every owner value in effect across two syncs, with a conflict where the second sync moves a converged field', () => {
    // First sync: a1 weight converges on the owner's 25, a2's due moves elsewhere, a3 joins g1 as the owner said, g1 and a4 are unchanged,
    // and a1's name and a2's score are untouched.
    const first = {
      ...base, a1: fields({ name: 'Assignment 1', weight: 25 }), a2: fields({ name: 'Assignment 2', weight: 15, due: '2026-11-10T12:59:00Z' }),
      a3: fields({ name: 'Quiz 1', weight: 5, parent: '100:g1' }),
    };
    const once = mergeCorrections(base, first, { courseId: '100', corrections, pins: {}, conflicts: [] }, at);
    expectOwnerValues(once, first);
    expect(once.pins).toEqual({ '100:a1': ['weight'], '100:a3': ['parent'] });
    expect(summary(once.conflicts)).toEqual([['field', '100:a2', 'due']]);

    // Second sync changes the weight that converged (a1 to 30) and the parent (a3 leaves g1); everything else stays.
    const second = { ...first, a1: fields({ name: 'Assignment 1', weight: 30 }), a3: fields({ name: 'Quiz 1', weight: 5, parent: null }) };
    const twice = mergeCorrections(first, second, { courseId: '100', ...once }, at);
    expectOwnerValues(twice, second);
    expect(summary(twice.conflicts)).toEqual([['field', '100:a2', 'due'], ['field', '100:a1', 'weight'], ['field', '100:a3', 'parent']]);
    expect(twice.conflicts.find(conflict => conflict.key === '100:a1')).toMatchObject({ base: 25, incoming: 30, user: 25 });
  });
});

describe('resolveConflict', () => {
  const fieldConflict = (key: string, field: string): Conflict => ({ id: conflictId('field', key, field), type: 'field', key, assessmentId: key.slice(4), field, base: 20, incoming: 25, user: 30, detectedAt: at });
  const choose = (...args: Parameters<typeof resolveConflict>) => resolveConflict(...args)!;
  const current = () => ({
    corrections: { '100:a1': { weight: 30, name: 'Mine' }, '100:a2': { weight: 40 }, '100:a3': { mergeInto: '100:a9', hidden: true } } as Record<string, Correction>,
    pins: { '100:a1': ['weight'] },
    conflicts: [
      fieldConflict('100:a1', 'weight'), fieldConflict('100:a2', 'weight'),
      { id: conflictId('orphaned', '100:a2', null), type: 'orphaned', key: '100:a2', assessmentId: 'a2', field: null, base: null, incoming: null, user: { weight: 40 }, detectedAt: at },
      { id: conflictId('dangling', '100:a3', 'mergeInto'), type: 'dangling', key: '100:a3', assessmentId: 'a3', field: 'mergeInto', base: null, incoming: null, user: '100:a9', detectedAt: at },
    ] as Conflict[],
  });

  it('sync on a field conflict removes the field and its pin and closes the conflict', () => {
    const result = choose(current(), conflictId('field', '100:a1', 'weight'), 'sync');
    expect(result.corrections['100:a1']).toEqual({ name: 'Mine' });
    expect(result.pins).toEqual({});
    expect(result.conflicts.map(conflict => conflict.id)).not.toContain(conflictId('field', '100:a1', 'weight'));
  });

  it('sync on the last field removes the correction', () => {
    const removed = choose({ corrections: { '100:a1': { weight: 30 } }, pins: {}, conflicts: [fieldConflict('100:a1', 'weight')] }, conflictId('field', '100:a1', 'weight'), 'sync');
    expect(removed).toEqual({ corrections: {}, pins: {}, conflicts: [] });
  });

  it('sync on an orphaned conflict deletes the correction and every conflict on it', () => {
    const result = choose(current(), conflictId('orphaned', '100:a2', null), 'sync');
    expect(result.corrections['100:a2']).toBeUndefined();
    expect(result.conflicts.some(conflict => conflict.key === '100:a2')).toBe(false);
  });

  it('sync on a dangling conflict deletes that field only', () => {
    const result = choose(current(), conflictId('dangling', '100:a3', 'mergeInto'), 'sync');
    expect(result.corrections['100:a3']).toEqual({ hidden: true });
    expect(result.conflicts.some(conflict => conflict.key === '100:a3')).toBe(false);
  });

  it('mine closes the conflict and keeps the correction and pins', () => {
    const before = current();
    const result = choose(before, conflictId('field', '100:a1', 'weight'), 'mine');
    expect(result.corrections).toEqual(before.corrections);
    expect(result.pins).toEqual(before.pins);
    expect(result.conflicts).toHaveLength(3);
  });

  it('mine is not raised again by a later merge while the sync keeps its value', () => {
    const merged = mergeCorrections({ a1: fields() }, { a1: fields({ weight: 25 }) }, { courseId: '100', corrections: { '100:a1': { weight: 30 } }, pins: {}, conflicts: [] }, at);
    const kept = choose(merged, merged.conflicts[0]!.id, 'mine');
    const later = mergeCorrections({ a1: fields({ weight: 25 }) }, { a1: fields({ weight: 25, name: 'Renamed' }) }, { courseId: '100', ...kept }, at);
    expect(later.corrections).toEqual({ '100:a1': { weight: 30 } });
    expect(later.conflicts).toEqual([]);
  });

  it('returns null for an unknown conflict', () => {
    expect(resolveConflict(current(), 'ffffffffffffffff', 'sync')).toBeNull();
  });
});
