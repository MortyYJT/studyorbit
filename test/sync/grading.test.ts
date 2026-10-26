import { describe, expect, it } from 'vitest';
import type { GroupsStage } from '../../src/sync/canvas-api.js';
import type { SkeletonStage } from '../../src/sync/handbook.js';
import type { ItemsClassifyInput, QuizzesReadInput } from '../../src/protocol/sync.js';
import { gradeItems } from '../../src/sync/grading.js';

const courseCode = 'ABCD10001';
const source = 'https://canvas.lms.unimelb.edu.au/api/v1/courses/900001/assignment_groups?include[]=assignments';
const at = '2026-10-24T00:00:00Z';
const assignmentsKey = `${courseCode}:assignments`;

interface SyntheticItem { id: string; name: string; due?: string | null }

/** A Canvas groups stage with one synthetic group and its synthetic assignments. */
function groupsStage(weight: number, items: SyntheticItem[], name = 'Synthetic Group'): GroupsStage {
  const group = { id: '501', name, weight: { value: weight, state: 'found' as const, via: 'api' as const, source } };
  return { source, via: 'api', coverage: 'api', unweighted: weight === 0, groups: [{ ...group, assignments: items.map(item => ({
    id: item.id, name: item.name, courseId: '900001', assignmentGroupId: group.id, group,
    due: { value: item.due === undefined ? '2026-10-31T12:59:00Z' : item.due, state: 'found' as const, via: 'api' as const, source },
    unlockAt: { value: '2026-10-01T00:00:00Z', state: 'found' as const, via: 'api' as const, source },
    outOf: { value: 14, state: 'found' as const, via: 'api' as const, source },
    score: { value: null, state: 'unknown' as const, checkedAt: at },
    status: { value: 'not_started' as const, state: 'found' as const, via: 'api' as const, source },
    updatedAt: { value: '2026-10-20T08:00:00Z', state: 'found' as const, via: 'api' as const, source },
  })) }] };
}

function skeletonStage(components: SkeletonStage['components']): SkeletonStage {
  return { source: 'https://handbook.unimelb.edu.au/2026/subjects/abcd10001/assessment', via: 'handbook', components };
}

function classificationStage(items: ItemsClassifyInput['items']): ItemsClassifyInput {
  return { jobId: 'synthetic-job', courseKey: 'ABCD10001:2026:S2', items };
}

function quizzesStage(quizzes: QuizzesReadInput['quizzes']): QuizzesReadInput {
  return { jobId: 'synthetic-job', courseKey: 'ABCD10001:2026:S2', quizzes };
}

const assignments = skeletonStage([{ name: 'Assignments', weight: 30, quote: 'Assignments\tWeeks 3-10\t30%' }]);

describe('grading rule (layered-sync task 6.1)', () => {
  it('Extension token survey: a weight-0 survey item with no weighted component is ungraded, not a quiz', () => {
    const result = gradeItems({
      courseCode,
      groups: groupsStage(0, [{ id: '700001', name: 'Token Use: Assignment 1 Extensions' }], 'Synthetic Survey'),
      skeleton: assignments,
      classification: classificationStage([{ id: '700001', category: 'quiz', evidence: 'Synthetic survey group name' }]),
      quizzes: quizzesStage([{ id: '700001', name: 'Token Use: Assignment 1 Extensions', survey: true, practice: false }]),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: '700001', name: 'Token Use: Assignment 1 Extensions', category: 'ungraded', graded: false });
    expect(result.conflicts).toEqual([]);
  });

  it('Practice quiz: a practice quiz in a weight-0 group mapping to no weighted component is ungraded', () => {
    const result = gradeItems({
      courseCode,
      groups: groupsStage(0, [{ id: '700002', name: 'Synthetic Practice Quiz' }], 'Synthetic Practice'),
      skeleton: assignments,
      classification: classificationStage([{ id: '700002', category: 'quiz', evidence: 'Synthetic practice group name' }]),
      quizzes: quizzesStage([{ id: '700002', name: 'Synthetic Practice Quiz', survey: false, practice: true }]),
    });
    expect(result.items[0]).toMatchObject({ id: '700002', category: 'ungraded', graded: false });
    expect(result.conflicts).toEqual([]);
  });

  it('Weight-0 group with a weighted component: graded under the component, effective 30, and a weight conflict 0/30', () => {
    const result = gradeItems({
      courseCode,
      groups: groupsStage(0, [{ id: '700003', name: 'Synthetic Assignment 1' }], 'Synthetic Assignments'),
      skeleton: assignments,
      classification: classificationStage([{ id: '700003', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
    });
    expect(result.items[0]).toMatchObject({ id: '700003', category: 'assignment', graded: true,
      componentKey: assignmentsKey, groupWeight: 0, effectiveComponentWeight: 30 });
    expect(result.conflicts).toEqual([{ field: 'weight', componentKey: assignmentsKey, skeletonValue: 30, canvasValue: 0 }]);
  });

  it('Attendance hurdle kept: weight 0 with an 80% attendance hurdle stays participation with its hurdle', () => {
    const result = gradeItems({
      courseCode,
      groups: groupsStage(0, [{ id: '700004', name: 'Synthetic Attendance' }], 'Synthetic Participation'),
      skeleton: skeletonStage([{ name: 'Attendance', weight: 0,
        hurdle: 'Students must attend at least 80% of tutorials.', quote: 'Attendance\tThroughout semester\t0%' }]),
      classification: classificationStage([{ id: '700004', category: 'participation', component: 'Attendance', evidence: 'Synthetic attendance group name' }]),
    });
    expect(result.items[0]).toMatchObject({ id: '700004', category: 'participation', graded: true,
      componentKey: `${courseCode}:attendance`, groupWeight: 0, effectiveComponentWeight: 0,
      hurdle: 'Students must attend at least 80% of tutorials.' });
    expect(result.items[0]!.category).not.toBe('ungraded');
    expect(result.conflicts).toEqual([]);
  });

  it('Handbook 30 vs Canvas 40: effective 40 and a weight conflict; resolved skeleton makes it 30', () => {
    const input = {
      courseCode,
      groups: groupsStage(40, [{ id: '700005', name: 'Synthetic Assignment 2' }], 'Synthetic Assignments'),
      skeleton: assignments,
      classification: classificationStage([{ id: '700005', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' }]),
    };
    const first = gradeItems(input);
    expect(first.items[0]).toMatchObject({ componentKey: assignmentsKey, groupWeight: 40, effectiveComponentWeight: 40 });
    expect(first.conflicts).toEqual([{ field: 'weight', componentKey: assignmentsKey, skeletonValue: 30, canvasValue: 40 }]);
    const second = gradeItems({ ...input, resolved: { weight: { [assignmentsKey]: 'skeleton' } } });
    expect(second.items[0]).toMatchObject({ componentKey: assignmentsKey, effectiveComponentWeight: 30 });
  });

  it('Unmatched: a graded item with no component opens unmatched; resolving assigns the component or dismisses it', () => {
    const input = {
      courseCode,
      groups: groupsStage(20, [{ id: '700006', name: 'Synthetic Report', due: '2026-11-07T12:59:00Z' }], 'Synthetic Weighted'),
      skeleton: assignments,
      classification: classificationStage([{ id: '700006', category: 'assignment', evidence: 'Synthetic weighted group name' }]),
    };
    const first = gradeItems(input);
    expect(first.items[0]).toMatchObject({ id: '700006', category: 'assignment', graded: true });
    expect(first.items[0]).not.toHaveProperty('componentKey');
    expect(first.conflicts).toEqual([{ field: 'unmatched', canvasAssignmentId: '700006',
      canvasValue: { id: '700006', name: 'Synthetic Report', due: '2026-11-07T12:59:00Z' } }]);

    const assigned = gradeItems({ ...input, resolved: { unmatched: { '700006': assignmentsKey } } });
    expect(assigned.items[0]).toMatchObject({ componentKey: assignmentsKey, effectiveComponentWeight: 20 });
    expect(assigned.conflicts.some(conflict => conflict.field === 'unmatched')).toBe(false);

    const dismissed = gradeItems({ ...input, resolved: { unmatched: { '700006': 'dismissed' } } });
    expect(dismissed.items[0]).toMatchObject({ graded: true });
    expect(dismissed.items[0]).not.toHaveProperty('componentKey');
    expect(dismissed.conflicts).toEqual([]);
  });

  it('No classification: ungraded in a weight-0 group, but graded as unknown without a component in a weighted group', () => {
    const zero = gradeItems({ courseCode, groups: groupsStage(0, [{ id: '700007', name: 'Synthetic Unclassified' }]) });
    expect(zero.items[0]).toMatchObject({ category: 'ungraded', graded: false });
    expect(zero.conflicts).toEqual([]);

    const weighted = gradeItems({ courseCode, groups: groupsStage(20, [{ id: '700008', name: 'Synthetic Unclassified Weighted' }]) });
    expect(weighted.items[0]).toMatchObject({ category: 'unknown', graded: true });
    expect(weighted.items[0]).not.toHaveProperty('componentKey');
    expect(weighted.conflicts).toEqual([{ field: 'unmatched', canvasAssignmentId: '700008',
      canvasValue: { id: '700008', name: 'Synthetic Unclassified Weighted', due: '2026-10-31T12:59:00Z' } }]);
  });

  it('A classified quiz id that is not a Canvas assignment id maps to a groups item by name; others are ignored', () => {
    const skeleton = skeletonStage([{ name: 'Quizzes', weight: 10, quote: 'Quizzes\tWeeks 2-12\t10%' }]);
    const result = gradeItems({
      courseCode,
      groups: groupsStage(0, [{ id: '700009', name: 'Synthetic Quiz 1' }]),
      skeleton,
      classification: classificationStage([
        { id: '800001', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic quiz page name' },
        { id: '800002', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic quiz page name' },
      ]),
      quizzes: quizzesStage([
        { id: '800001', name: 'Synthetic Quiz 1', survey: false, practice: false },
        { id: '800002', name: 'Synthetic Quiz Not In Groups', survey: false, practice: false },
      ]),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: '700009', category: 'quiz', graded: true,
      componentKey: `${courseCode}:quizzes`, effectiveComponentWeight: 10 });
  });
});
