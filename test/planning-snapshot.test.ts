import { describe, expect, it } from 'vitest';
import { buildPlanningSnapshot, parsePlanningSnapshot, SNAPSHOT_TASK_LIMIT } from '../shared/planning-snapshot.ts';
import { schedulePlan } from '../shared/planning.ts';

// The planning snapshot the Agent page sends with a message (decision #322). Synthetic data only.
type Task = { key: string; courseId: string; courseCode: string; title: string; due: string; minutes: number; spent?: number; done?: boolean };
const task = (key: string, patch: Partial<Task> & Record<string, unknown> = {}): Task => ({ key, courseId: 'syn-1', courseCode: 'SYN10001', title: `Task ${key}`, due: '2026-09-20', minutes: 60, ...patch });
const availability = [60, 60, 60, 60, 60, 0, 0];

describe('buildPlanningSnapshot', () => {
  it('sends the weekly page task set (loaded courses and personal tasks), with page keys, regardless of chat scope', () => {
    const work = [task('syn-1:a'), task('syn-2:b', { courseId: 'syn-2', courseCode: 'SYN20002' }), task('personal:c', { courseId: '', courseCode: '' }),
      task('syn-9:d', { courseId: 'syn-9' }), task('syn-1:e', { done: true }), task('syn-1:f', { spent: 15, done: false })];
    const snapshot = buildPlanningSnapshot({ work, availability, targets: { 'syn-1': 'H1', 'syn-2': 'P', 'syn-9': 'H3' }, courseIds: ['syn-1', 'syn-2'] });
    expect(snapshot.tasks.map(item => item.key)).toEqual(['personal:c', 'syn-1:a', 'syn-1:f', 'syn-2:b']);
    expect(snapshot.tasks[1]).toEqual({ key: 'syn-1:a', title: 'Task syn-1:a', courseId: 'syn-1', courseCode: 'SYN10001', due: '2026-09-20', minutes: 60 });
    expect(snapshot.tasks[2]!.spent).toBe(15);
    expect(snapshot.targets).toEqual({ 'syn-1': 'H1', 'syn-2': 'P' });
    expect(snapshot.availability).toEqual(availability);
    expect(snapshot.omitted).toBeUndefined();
    expect(parsePlanningSnapshot(snapshot)).toEqual({ ok: true, planning: snapshot });
  });

  it('keeps the first 500 unfinished tasks in due-then-key order, cuts titles and leaves the plan of those tasks unchanged', () => {
    const work = Array.from({ length: 520 }, (_, index) => task(`syn-1:${String(519 - index).padStart(3, '0')}`, {
      due: `2026-10-${String(1 + (index % 28)).padStart(2, '0')}`, minutes: 30, title: 'x'.repeat(250),
    }));
    const snapshot = buildPlanningSnapshot({ work, availability, targets: {}, courseIds: ['syn-1'] });
    expect(snapshot.tasks).toHaveLength(SNAPSHOT_TASK_LIMIT);
    expect(snapshot.omitted).toBe(20);
    expect(snapshot.tasks.every(item => item.title.length === 200)).toBe(true);
    const sorted = [...work].sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key));
    expect(snapshot.tasks.map(item => item.key)).toEqual(sorted.slice(0, 500).map(item => item.key));
    const full = schedulePlan(work, availability, '2026-09-14');
    const sent = schedulePlan(snapshot.tasks, availability, '2026-09-14');
    const keys = new Set(snapshot.tasks.map(item => item.key));
    for (const [day, blocks] of Object.entries(full.days)) expect(sent.days[day] ?? []).toEqual(blocks.filter(block => keys.has(block.key)));
    expect(parsePlanningSnapshot(snapshot).ok).toBe(true);
  });
});

describe('parsePlanningSnapshot', () => {
  const valid = { tasks: [task('syn-1:a')], availability, targets: { 'syn-1': 'H2A' } };
  it('accepts a missing snapshot as no planning data', () => {
    expect(parsePlanningSnapshot(undefined)).toEqual({ ok: true, planning: null });
    expect(parsePlanningSnapshot(null)).toEqual({ ok: true, planning: null });
  });

  it('rejects invalid snapshots strictly', () => {
    const bad = [
      { ...valid, tasks: [task('a', { due: 'next week' })] },
      { ...valid, tasks: [task('a', { due: '2026-02-30' })] },
      { ...valid, tasks: [task('a', { minutes: 0 })] },
      { ...valid, tasks: [task('a', { minutes: 100001 })] },
      { ...valid, tasks: [task('a', { title: 'x'.repeat(201) })] },
      { ...valid, tasks: [task('a', { extra: true })] },
      { ...valid, tasks: Array.from({ length: 501 }, (_, index) => task(`k${index}`)) },
      { ...valid, availability: [60, 60] },
      { ...valid, availability: [60, 60, 60, 60, 60, 60, 2000] },
      { ...valid, targets: { 'syn-1': 'A+' } },
      { ...valid, extra: 1 },
      'tasks',
    ];
    for (const value of bad) expect(parsePlanningSnapshot(value)).toEqual({ ok: false });
    expect(parsePlanningSnapshot(valid)).toEqual({ ok: true, planning: valid });
  });
});
