import { describe, expect, it } from 'vitest';
import { calculateGrades, parentGrade, type GradingGroup, type GradingItem } from '../shared/course-calculations.js';

/** Synthetic assessment with safe defaults; no real course data. */
function item(key: string, fields: Partial<GradingItem> = {}): GradingItem {
  return { key, caution: false, sourceZero: false, kind: 'quiz', ...fields };
}

describe('parentGrade', () => {
  it('uses the stated component score when one is recorded', () => {
    const group: GradingGroup = { weight: 20, score: 15, outOf: 20, children: [], scoringRule: 'points' };
    expect(parentGrade(group)).toEqual({ score: 15, outOf: 20, earned: 15 });
  });

  it('sums child points and skips bonus or ungraded children', () => {
    const group: GradingGroup = {
      weight: 10, scoringRule: 'points', children: [
        item('Synthetic Quiz 1', { score: 8, outOf: 10 }),
        item('Synthetic Quiz 2', { score: 4, outOf: 10 }),
        item('Synthetic Bonus', { score: 5, outOf: 5, bonus: true }),
        item('Synthetic Practice', { kind: 'ungraded', score: 0, outOf: 10 }),
      ],
    };
    expect(parentGrade(group)).toEqual({ score: 12, outOf: 20, earned: 6 });
  });

  it('returns undefined while a child is still ungraded or weights do not match', () => {
    const pending: GradingGroup = { weight: 10, scoringRule: 'points', children: [item('Synthetic Quiz 1', { score: 8, outOf: 10 }), item('Synthetic Quiz 2')] };
    expect(parentGrade(pending)).toBeUndefined();
    const mismatched: GradingGroup = { weight: 10, scoringRule: 'weighted', children: [item('Synthetic Lab 1', { weightValue: 4, score: 5, outOf: 10 }), item('Synthetic Lab 2', { weightValue: 4, score: 10, outOf: 10 })] };
    expect(parentGrade(mismatched)).toBeUndefined();
  });
});

describe('calculateGrades', () => {
  it('combines standalone items with completed groups without counting a child twice', () => {
    const children = [item('Synthetic Quiz 1', { weightValue: 5, score: 10, outOf: 10 }), item('Synthetic Quiz 2', { weightValue: 5, score: 5, outOf: 10 })];
    const assessments = [
      ...children,
      item('Synthetic Assignment', { kind: 'assignment', weightValue: 30, score: 24, outOf: 30 }),
      item('Synthetic Exam', { kind: 'exam', weightValue: 60 }),
    ];
    const groups: GradingGroup[] = [{ weight: 10, scoringRule: 'weighted', children }];
    const result = calculateGrades(assessments, groups);
    expect(result.weight).toBe(40);
    expect(result.earned).toBeCloseTo(7.5 + 24);
    expect(result.average).toBeCloseTo(31.5 / 40 * 100);
  });

  it('reports no average when nothing is graded', () => {
    expect(calculateGrades([item('Synthetic Exam', { kind: 'exam', weightValue: 60 })], [])).toEqual({ weight: 0, earned: 0, average: undefined });
  });
});
