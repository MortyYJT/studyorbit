import { describe, expect, it } from 'vitest';
import { defaultAvailability, parseAvailability, schedulePlan, type PlanTask } from '../shared/planning.js';

// One test per scenario in specs/weekly-plan/spec.md. 2026-03-02 is a Monday; all tasks are synthetic.
const monday = '2026-03-02';
const flat = (minutes: number) => Array<number>(7).fill(minutes);
const task = (key: string, due: string, minutes: number, extra: Partial<PlanTask> = {}): PlanTask => ({ key, due, minutes, ...extra });

describe('schedulePlan', () => {
  it('places the earlier deadline first', () => {
    const plan = schedulePlan([task('A', '2026-03-05', 60), task('B', '2026-03-03', 60)], flat(60), monday);
    expect(plan.days[monday]).toEqual([{ key: 'B', minutes: 60 }]);
    expect(plan.days['2026-03-03']).toEqual([{ key: 'A', minutes: 60 }]);
    expect(plan.overflow).toEqual([]);
  });

  it('splits a task across days up to and including its deadline', () => {
    const plan = schedulePlan([task('A', '2026-03-04', 150)], flat(60), monday);
    expect([plan.days[monday], plan.days['2026-03-03'], plan.days['2026-03-04']]).toEqual([[{ key: 'A', minutes: 60 }], [{ key: 'A', minutes: 60 }], [{ key: 'A', minutes: 30 }]]);
    expect(plan.overflow).toEqual([]);
  });

  it('schedules only the minutes not yet spent, and nothing for done tasks', () => {
    const plan = schedulePlan([task('A', '2026-03-04', 120, { spent: 90 }), task('B', '2026-03-04', 60, { done: true }), task('C', '2026-03-04', 30, { spent: 45 })], flat(120), monday);
    expect(plan.days).toEqual({ [monday]: [{ key: 'A', minutes: 30 }] });
  });

  it('lists minutes that do not fit before the deadline as overflow', () => {
    const plan = schedulePlan([task('A', monday, 200)], flat(120), monday);
    expect(plan.days[monday]).toEqual([{ key: 'A', minutes: 120 }]);
    expect(plan.overflow).toEqual([{ key: 'A', minutes: 80, overdue: false }]);
  });

  it('lists an unfinished task whose deadline has passed as overdue', () => {
    const plan = schedulePlan([task('A', '2026-03-01', 60, { spent: 20 })], flat(120), monday);
    expect(plan.days).toEqual({});
    expect(plan.overflow).toEqual([{ key: 'A', minutes: 40, overdue: true }]);
  });

  it('still lists an overdue task as unfinished when its estimate is used up but it is not marked done', () => {
    const plan = schedulePlan([task('A', '2026-03-01', 60, { spent: 60 })], flat(120), monday);
    expect(plan.overflow).toEqual([{ key: 'A', minutes: 0, overdue: true }]);
  });

  it('works in whole minutes when estimates, spent time or availability are fractional', () => {
    const plan = schedulePlan([task('A', '2026-03-03', 60, { spent: 59.9 }), task('B', '2026-03-03', 100)], flat(72.7), monday);
    expect(plan.days[monday]).toEqual([{ key: 'A', minutes: 1 }, { key: 'B', minutes: 71 }]);
    expect(plan.days['2026-03-03']).toEqual([{ key: 'B', minutes: 29 }]);
  });

  it('plans at most a year ahead and does not call a far deadline overflow', () => {
    const started = Date.now();
    const plan = schedulePlan([task('A', '9026-03-02', 600)], flat(0), monday);
    expect(Date.now() - started).toBeLessThan(200);
    expect(plan).toEqual({ days: {}, overflow: [] });
  });

  it('places nothing on days with zero availability', () => {
    // Saturday and Sunday off: a task due Sunday must fit by Friday.
    const plan = schedulePlan([task('A', '2026-03-08', 300)], [60, 60, 60, 60, 60, 0, 0], monday);
    expect(Object.keys(plan.days)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);
    expect(plan.overflow).toEqual([]);
  });

  it('gives the same schedule whatever order the tasks arrive in', () => {
    const tasks = [task('b', '2026-03-03', 90), task('a', '2026-03-03', 90), task('c', '2026-03-04', 45)];
    const first = schedulePlan(tasks, flat(100), monday);
    expect(schedulePlan([...tasks].reverse(), flat(100), monday)).toEqual(first);
    expect(first.days[monday]).toEqual([{ key: 'a', minutes: 90 }, { key: 'b', minutes: 10 }]);
  });
});

describe('parseAvailability', () => {
  it('keeps valid weekday minutes and falls back per day otherwise', () => {
    expect(parseAvailability([0, 30, 1440, 90, 60, 0, 0])).toEqual([0, 30, 1440, 90, 60, 0, 0]);
    expect(parseAvailability([-5, 'x', 2000, 90.5, null, 0, 10])).toEqual([defaultAvailability[0], defaultAvailability[1], defaultAvailability[2], 90.5, defaultAvailability[4], 0, 10]);
    expect(parseAvailability('nope')).toEqual(defaultAvailability);
  });
});
