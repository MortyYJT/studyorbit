import { expect, it } from 'vitest';
import { planDays } from '../../src/planning/planner.js';
import type { WorkItem } from '../../src/planning/work.js';
const settings = { timeZone: 'Australia/Melbourne', weekdayMinutes: [60, 60, 60, 60, 60, 60, 60], teachingWeekAnchor: '2026-10-19', breakWeeks: [] };
const work = (workId: string, estimateMinutes?: number, due?: string): WorkItem => ({ workId, title: workId, estimateMinutes, due, actualMinutes: 0 });
const input = (items: WorkItem[], horizonDays = 2) => ({ settings, startDate: '2026-10-19', horizonDays, items });
it('splits 180 into 120 assigned and 60 visible overflow before the deadline', () => {
  const result = planDays(input([work('a', 180, '2026-10-20T00:00:00Z')]));
  expect(result.days.map(day => day.items)).toEqual([[{ workId: 'a', minutes: 60 }], [{ workId: 'a', minutes: 60 }]]);
  expect(result.overflow).toEqual([{ workId: 'a', minutes: 60 }]);
});
it('orders overdue first, undated last and equal deadlines by stable id', () => {
  const result = planDays(input([work('z', 10), work('b', 10, '2026-10-19T01:00:00Z'), work('a', 10, '2026-10-19T01:00:00Z'), work('late', 10, '2026-10-18T00:00:00Z')], 1));
  expect(result.days[0]!.items.map(item => item.workId)).toEqual(['late', 'a', 'b', 'z']);
});
it('lists unestimated work with its due and assigns no minutes', () => {
  const a = work('a', undefined, '2026-10-19T00:00:00Z');
  const result = planDays(input([a]));
  expect(result.unestimated).toEqual([a]); expect(result.days.every(day => !day.items.length)).toBe(true);
});
it('uses Melbourne local deadline date rather than UTC', () => {
  const result = planDays(input([work('a', 180, '2026-10-20T13:30:00Z')], 3));
  expect(result.days[2]).toMatchObject({ date: '2026-10-21', items: [{ workId: 'a', minutes: 60 }] });
  expect(result.overflow).toEqual([]);
});
it('is identical for identical inputs and leaves inputs untouched', () => {
  const value = input([work('a', 300)]); const before = structuredClone(value);
  expect(planDays(value)).toEqual(planDays(value)); expect(value).toEqual(before);
});
it('keeps overdue work first across days instead of letting later work displace its remainder', () => {
  const result = planDays(input([work('later', 60, '2026-10-20T00:00:00Z'), work('overdue', 120, '2026-10-18T00:00:00Z')]));
  expect(result.days.map(day => day.items)).toEqual([[{ workId: 'overdue', minutes: 60 }], [{ workId: 'overdue', minutes: 60 }]]);
  expect(result.overflow).toEqual([{ workId: 'later', minutes: 60 }]);
});
