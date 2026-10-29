import { describe, expect, it } from 'vitest';
import { calculateGrades, gradeBreakdown, parentGrade, type GradingGroup, type GradingItem } from '../shared/course-calculations.js';

// Synthetic assessments only; no real course data.
function item(key: string, fields: Partial<GradingItem> = {}): GradingItem {
  return { key, caution: false, sourceZero: false, kind: 'quiz', ...fields };
}

/** The calculation before it was rewritten on top of gradeBreakdown, kept as a reference. */
function referenceGrades(assessments: GradingItem[], parents: GradingGroup[]) {
  const completed = parents.flatMap(parent => { const grade = parentGrade(parent); return grade ? [{ parent, grade }] : []; });
  const counted = new Set(completed.flatMap(({ parent }) => [...parent.children.map(child => child.key), ...(parent.sourceKey ? [parent.sourceKey] : [])]));
  const graded = assessments.filter(item => !item.bonus && !item.ungraded && !counted.has(item.key) && item.weightValue !== undefined && item.score !== undefined && item.outOf !== undefined && item.outOf > 0 && item.score >= 0 && item.score <= item.outOf && !item.caution && !item.sourceZero && item.kind !== 'ungraded');
  const weight = graded.reduce((sum, item) => sum + item.weightValue!, 0) + completed.reduce((sum, item) => sum + item.parent.weight!, 0);
  const earned = graded.reduce((sum, item) => sum + item.weightValue! * item.score! / item.outOf!, 0) + completed.reduce((sum, item) => sum + item.grade.earned, 0);
  return { weight, earned, average: weight ? earned / weight * 100 : undefined };
}

describe('gradeBreakdown', () => {
  it('lists a counted leaf and a counted points group with their earned points', () => {
    const children = [item('q1', { score: 8, outOf: 10 }), item('q2', { score: 6, outOf: 10 })];
    const assessments = [item('a1', { kind: 'assignment', weightValue: 20, score: 15, outOf: 20 }), item('quizzes', { weightValue: 30 }), ...children, item('exam', { kind: 'exam', weightValue: 50, outOf: 100 })];
    const result = gradeBreakdown(assessments, [{ weight: 30, children, scoringRule: 'points', sourceKey: 'quizzes' }]);
    expect(result.counted).toEqual([
      { key: 'a1', group: false, weight: 20, earned: 15 },
      { key: 'quizzes', group: true, weight: 30, earned: 21 },
    ]);
    expect(result.excluded).toEqual([{ key: 'exam', reason: 'no-mark' }]);
  });

  it('gives a reason for every item that does not count', () => {
    const pending = [item('p1', { score: 4, outOf: 5 }), item('p2')];
    const assessments = [
      item('bonus', { bonus: true, score: 2, outOf: 2 }),
      item('practice', { ungraded: true, score: 1, outOf: 1 }),
      item('kind-ungraded', { kind: 'ungraded', weightValue: 5, score: 1, outOf: 1 }),
      item('alt', { caution: true, weightValue: 50, score: 40, outOf: 50 }),
      item('zero', { sourceZero: true, weightValue: 0, score: 3, outOf: 3 }),
      item('no-weight', { score: 3, outOf: 3 }),
      item('future', { weightValue: 10 }),
      item('over', { weightValue: 10, score: 11, outOf: 10 }),
      item('labs', { weightValue: 20 }), ...pending,
      item('unweighted-group'), item('u1', { score: 1, outOf: 1 }),
    ];
    const groups: GradingGroup[] = [
      { weight: 20, children: pending, scoringRule: 'points', sourceKey: 'labs' },
      { children: [assessments[assessments.length - 1]], scoringRule: 'points', sourceKey: 'unweighted-group' },
    ];
    const result = gradeBreakdown(assessments, groups);
    expect(result.counted).toEqual([]);
    expect(Object.fromEntries(result.excluded.map(entry => [entry.key, entry.reason]))).toEqual({
      bonus: 'bonus', practice: 'ungraded', 'kind-ungraded': 'ungraded', alt: 'alternative', zero: 'zero-weight', 'no-weight': 'no-weight',
      future: 'no-mark', over: 'no-mark', labs: 'incomplete-group', p1: 'incomplete-group', p2: 'incomplete-group',
      'unweighted-group': 'no-weight', u1: 'no-weight',
    });
  });

  it('counts a weighted child alone while its group is incomplete, and only the group once it completes', () => {
    const children = [item('l1', { weightValue: 5, score: 4, outOf: 5 }), item('l2', { weightValue: 5 })];
    const assessments = [item('labs', { weightValue: 10 }), ...children];
    const incomplete = gradeBreakdown(assessments, [{ weight: 10, children, scoringRule: 'weighted', sourceKey: 'labs' }]);
    expect(incomplete.counted).toEqual([{ key: 'l1', group: false, weight: 5, earned: 4 }]);
    expect(incomplete.excluded).toEqual([{ key: 'labs', reason: 'incomplete-group' }, { key: 'l2', reason: 'no-mark' }]);
    const done = [children[0], item('l2', { weightValue: 5, score: 5, outOf: 5 })];
    const complete = gradeBreakdown([assessments[0], ...done], [{ weight: 10, children: done, scoringRule: 'weighted', sourceKey: 'labs' }]);
    expect(complete.counted).toEqual([{ key: 'labs', group: true, weight: 10, earned: 9 }]);
    expect(complete.excluded).toEqual([]);
  });

  it('reports a bonus child of a counted group as excluded and leaves the other children out of both lists', () => {
    const children = [item('q1', { score: 5, outOf: 10 }), item('qb', { bonus: true, score: 1, outOf: 1 })];
    const result = gradeBreakdown([item('quizzes', { weightValue: 10 }), ...children], [{ weight: 10, children, scoringRule: 'points', sourceKey: 'quizzes' }]);
    expect(result.counted).toEqual([{ key: 'quizzes', group: true, weight: 10, earned: 5 }]);
    expect(result.excluded).toEqual([{ key: 'qb', reason: 'bonus' }]);
  });

  it('counts a group without a source item after the leaves', () => {
    const children = [item('q1', { weightValue: 5, score: 10, outOf: 10 })];
    const result = gradeBreakdown([item('a1', { weightValue: 30, score: 15, outOf: 30 }), ...children], [{ weight: 5, children, scoringRule: 'weighted' }]);
    expect(result.counted).toEqual([{ key: 'a1', group: false, weight: 30, earned: 15 }, { key: 'group:0', group: true, weight: 5, earned: 5 }]);
  });

  it('sums to calculateGrades, which still matches the earlier calculation, on random inputs', () => {
    let seed = 12345;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)];
    for (let run = 0; run < 500; run += 1) {
      const leaf = (key: string, weighted: boolean): GradingItem => {
        const outOf = pick([undefined, 0, 10, 20, 7.5]);
        return item(key, {
          weightValue: weighted ? pick([undefined, 0, 5, 12.5, 20]) : pick([undefined, 5]), outOf,
          score: pick([undefined, -1, 0, 3, 6.25, 10, 25]), bonus: random() < 0.1, ungraded: random() < 0.05, caution: random() < 0.05,
          sourceZero: random() < 0.05, kind: pick(['quiz', 'exam', 'ungraded']),
        });
      };
      const assessments: GradingItem[] = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) => leaf(`a${index}`, true));
      const parents: GradingGroup[] = Array.from({ length: Math.floor(random() * 3) }, (_, index) => {
        const children = Array.from({ length: Math.floor(random() * 4) }, (_, child) => leaf(`g${index}c${child}`, random() < 0.5));
        const source = item(`g${index}`, { weightValue: pick([undefined, 0, 10, 15]) });
        assessments.push(source, ...children);
        return { weight: source.weightValue, score: pick([undefined, 4]), outOf: pick([undefined, 5]), children, scoringRule: pick(['points', 'weighted', 'none']), sourceKey: random() < 0.9 ? source.key : undefined };
      });
      const totals = calculateGrades(assessments, parents);
      expect(totals).toEqual(referenceGrades(assessments, parents));
      const { counted, excluded } = gradeBreakdown(assessments, parents);
      expect(counted.reduce((sum, entry) => sum + entry.weight, 0)).toBeCloseTo(totals.weight, 9);
      expect(counted.reduce((sum, entry) => sum + entry.earned, 0)).toBeCloseTo(totals.earned, 9);
      const keys = [...counted.map(entry => entry.key), ...excluded.map(entry => entry.key)];
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
