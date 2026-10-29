import { describe, expect, it } from 'vitest';
import { calculateGrades } from '../shared/course-calculations.js';
import { toDisplayDocument, type CourseDocument, type DisplayDocument } from '../shared/course-data.js';
import { schedulePlan } from '../shared/planning.js';
import { courseTools, gradingInputs, runTool, RESULT_LIMIT, toolDefinitions, type PlanningSnapshot, type ToolContext } from '../shared/course-tools.js';

// Synthetic courses only. 2026-09-14 is a Monday; Melbourne is UTC+10 until October.
type V2Item = Extract<CourseDocument, { version: 2 }>['assessments'][number];
type V1Item = Extract<CourseDocument, { version: 1 }>['assessments'][number];
const item = (patch: Partial<V2Item> & { id: string; name: string }): V2Item => ({
  kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: null,
  status: 'unknown', scoring: 'none', rule: null, sources: [], refs: [], weightQuote: null, ruleQuote: null, unsourced: [], ...patch,
});
const course = (id: string, code: string, assessments: V2Item[]): DisplayDocument => toDisplayDocument({
  version: 2, course: { id, code, name: `Synthetic ${code}`, term: '2026 Semester 2' }, assessments, materials: [], legacyIds: {},
});

const main = course('syn-1', 'SYN10001', [
  item({ id: 'a1', name: 'Assignment 1', weight: 20, score: 15, maxScore: 20, due: '2026-08-20T13:59:00Z', status: 'graded', rule: 'Late penalty 10% per day' }),
  item({ id: 'quizzes', name: 'Weekly quizzes', kind: 'quiz', weight: 30, scoring: 'points' }),
  item({ id: 'q1', name: 'Quiz 1', kind: 'quiz', parentId: 'quizzes', score: 8, maxScore: 10, due: '2026-08-10', status: 'graded' }),
  item({ id: 'q2', name: 'Quiz 2', kind: 'quiz', parentId: 'quizzes', score: 6, maxScore: 10, due: '2026-08-17', status: 'submitted' }),
  item({ id: 'bonus', name: 'Bonus challenge', nature: 'bonus', score: 1, maxScore: 2 }),
  item({ id: 'alt', name: 'Alternative exam', kind: 'test', nature: 'alternative', weight: 50 }),
  item({ id: 'part', name: 'Participation', kind: 'participation', unsourced: ['weight', 'rule'] }),
  item({ id: 'reflection', name: 'Reflection', weight: 0, due: '2026-09-15', status: 'submitted' }),
  item({ id: 'a2', name: 'Assignment 2', due: '2026-09-16T13:59:00Z', status: 'not_started' }),
  item({ id: 'exam', name: 'Final exam', kind: 'test', weight: 50, maxScore: 100, due: '2026-11-10', status: 'not_started', rule: 'Hurdle: at least 40%' }),
  item({ id: 'hurdle', name: 'Lab attendance', kind: 'hurdle', nature: 'ungraded', due: '2026-09-20', status: 'in_progress' }),
]);
const known = [{ id: 'syn-1', code: 'SYN10001', name: 'Synthetic SYN10001' }, { id: 'syn-2', code: 'SYN20002', name: 'Synthetic SYN20002' }];
const context = (patch: Partial<ToolContext> = {}): ToolContext => ({ documents: [main], courses: known, scope: ['syn-1', 'syn-2'], today: '2026-09-14', planning: null, ...patch });
const one = (doc: DisplayDocument, patch: Partial<ToolContext> = {}): ToolContext => context({ documents: [doc], scope: [doc.course.id], courses: [{ id: doc.course.id, code: doc.course.code }], ...patch });

// Results are plain JSON checked field by field.
type Value = any;
function ok(name: string, args: unknown, ctx: ToolContext = context()): Value {
  const result = runTool(name, args, ctx);
  if (!result.ok) throw new Error(`expected success, got ${result.text}`);
  expect(JSON.parse(result.text)).toEqual(result.value);
  return result.value;
}
function failure(name: string, args: unknown, ctx: ToolContext = context()): { code: string; message: string } {
  const result = runTool(name, args, ctx);
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.text)).toEqual(result.value);
  return (result.value as { error: { code: string; message: string } }).error;
}

describe('registry', () => {
  it('registers the six read-only tools with object JSON Schemas', () => {
    expect(courseTools.map(tool => tool.name)).toEqual(['list_courses', 'get_assessments', 'calculate_grades', 'final_needed', 'upcoming_deadlines', 'plan_schedule']);
    const definitions = toolDefinitions();
    expect(definitions.map(tool => tool.name)).toEqual(courseTools.map(tool => tool.name));
    for (const tool of definitions) {
      expect(tool.name).toMatch(/^[a-z_]{1,64}$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters).not.toHaveProperty('$schema');
    }
    const finalNeeded = definitions.find(tool => tool.name === 'final_needed')!.parameters;
    expect(Object.keys(finalNeeded.properties)).toEqual(['courseId', 'target', 'whatIf']);
    expect(finalNeeded.required).toEqual(['courseId']);
    expect(definitions.find(tool => tool.name === 'list_courses')!.parameters.properties).toEqual({});
  });

  it('returns an unknown tool as an error result', () => {
    const error = failure('delete_course', {});
    expect(error.code).toBe('UNKNOWN_TOOL');
    expect(error.message).toContain('list_courses');
  });

  it('names each invalid argument path', () => {
    const error = failure('final_needed', { courseId: 'syn-1', target: 'ninety' });
    expect(error.code).toBe('INVALID_ARGUMENTS');
    expect(error.message).toMatch(/^target: /);
    const nested = failure('calculate_grades', { courseId: 'syn-1', whatIf: [{ assessmentId: 'exam', percent: 120 }] });
    expect(nested.code).toBe('INVALID_ARGUMENTS');
    expect(nested.message).toContain('whatIf.0.percent: ');
    expect(failure('get_assessments', 'syn-1').code).toBe('INVALID_ARGUMENTS');
  });

  it('treats missing arguments as an empty object', () => {
    expect(ok('list_courses', undefined).courses).toHaveLength(2);
    expect(ok('list_courses', null).courses).toHaveLength(2);
  });

  it('refuses a course outside the scope and lists the allowed IDs', () => {
    const error = failure('get_assessments', { courseId: 'syn-9' }, context({ scope: ['syn-1'] }));
    expect(error.code).toBe('COURSE_NOT_IN_SCOPE');
    expect(error.message).toContain('syn-1');
    expect(failure('calculate_grades', { courseId: 'syn-2' }, context({ scope: ['syn-1'] })).code).toBe('COURSE_NOT_IN_SCOPE');
  });

  it('reports a scope course without synced data', () => {
    expect(failure('get_assessments', { courseId: 'syn-2' }).code).toBe('COURSE_NOT_SYNCED');
    expect(failure('final_needed', { courseId: 'syn-2' }).code).toBe('COURSE_NOT_SYNCED');
  });

  it('rounds numbers to two decimals', () => {
    const doc = course('syn-3', 'SYN30003', [item({ id: 'x', name: 'Thirds', weight: 10, score: 1, maxScore: 3 })]);
    const result = ok('calculate_grades', { courseId: 'syn-3' }, one(doc));
    expect(result.earned).toBe(3.33);
    expect(result.average).toBe(33.33);
  });

  it('gives the same answer for the same call and never changes the documents', () => {
    const ctx = context();
    const before = JSON.stringify(ctx);
    for (const tool of courseTools) {
      const args = tool.name === 'list_courses' || tool.name === 'upcoming_deadlines' || tool.name === 'plan_schedule' ? {} : { courseId: 'syn-1', ...(tool.name === 'get_assessments' ? {} : { whatIf: [{ assessmentId: 'exam', percent: 70 }] }) };
      expect(runTool(tool.name, args, ctx)).toEqual(runTool(tool.name, args, ctx));
    }
    expect(JSON.stringify(ctx)).toBe(before);
  });

  it('turns an unexpected failure inside a tool into an error result', () => {
    const broken = { ...context(), documents: [{ ...main, assessments: null }] } as unknown as ToolContext;
    expect(failure('calculate_grades', { courseId: 'syn-1' }, broken).code).toBe('TOOL_FAILED');
  });
});

describe('gradingInputs', () => {
  it('builds the inputs the course page uses for an uncorrected document', () => {
    const { assessments, parents } = gradingInputs(main);
    // Alternative items are left out; children of a counted parent stay in.
    expect(assessments.map(entry => entry.key)).toEqual(['a1', 'quizzes', 'q1', 'q2', 'bonus', 'part', 'reflection', 'a2', 'exam', 'hurdle']);
    expect(parents).toHaveLength(1);
    expect(parents[0]).toMatchObject({ weight: 30, scoringRule: 'points', sourceKey: 'quizzes' });
    expect(calculateGrades(assessments, parents)).toEqual({ weight: 50, earned: 36, average: 72 });
  });

  it('drops children of a bonus, alternative, ungraded or zero-weight parent', () => {
    const doc = course('syn-3', 'SYN30003', [
      item({ id: 'b', name: 'Bonus set', nature: 'bonus', scoring: 'points' }), item({ id: 'b1', name: 'Bonus 1', parentId: 'b', score: 1, maxScore: 1 }),
      item({ id: 'z', name: 'Practice set', weight: 0, scoring: 'points' }), item({ id: 'z1', name: 'Practice 1', parentId: 'z', score: 1, maxScore: 1 }),
    ]);
    const { assessments, parents } = gradingInputs(doc);
    expect(assessments.map(entry => entry.key)).toEqual(['b', 'z']);
    expect(parents).toEqual([]);
  });
});

describe('list_courses', () => {
  it('lists every scope course with its synced state and identified weight', () => {
    const v1: CourseDocument = { version: 1, course: { id: 'syn-2', code: 'SYN20002', name: 'Synthetic SYN20002', term: null }, materials: [],
      assessments: [{ id: 'e', name: 'Exam', kind: 'test', nature: 'regular', parentId: null, weight: 60, score: null, maxScore: null, due: null, status: 'unknown', scoring: 'none', rule: null, sources: [] } satisfies V1Item] };
    expect(ok('list_courses', {}, context({ documents: [main, toDisplayDocument(v1)], scope: ['syn-1', 'syn-2', 'syn-5'] }))).toEqual({
      today: '2026-09-14',
      courses: [
        { id: 'syn-1', code: 'SYN10001', name: 'Synthetic SYN10001', term: '2026 Semester 2', synced: true, version: 2, assessmentCount: 11, identifiedWeight: 100 },
        { id: 'syn-2', code: 'SYN20002', name: 'Synthetic SYN20002', term: null, synced: true, version: 1, assessmentCount: 1, identifiedWeight: 60 },
        { id: 'syn-5', code: null, name: null, term: null, synced: false, version: null, assessmentCount: null, identifiedWeight: null },
      ],
    });
    expect(ok('list_courses', {}).courses[1]).toEqual({ id: 'syn-2', code: 'SYN20002', name: 'Synthetic SYN20002', term: null, synced: false, version: null, assessmentCount: null, identifiedWeight: null });
  });
});

describe('get_assessments', () => {
  it('returns every assessment with Melbourne due times and unsourced flags', () => {
    const result = ok('get_assessments', { courseId: 'syn-1' });
    expect(result.courseId).toBe('syn-1');
    expect(result.code).toBe('SYN10001');
    expect(result.assessments).toHaveLength(11);
    expect(result.assessments[0]).toEqual({ id: 'a1', parentId: null, name: 'Assignment 1', kind: 'assignment', nature: 'regular', weight: 20, score: 15, maxScore: 20,
      due: '2026-08-20 23:59', status: 'graded', scoring: 'none', rule: 'Late penalty 10% per day' });
    expect(result.assessments[2]).toMatchObject({ id: 'q1', parentId: 'quizzes', due: '2026-08-10' });
    expect(result.assessments.find((entry: Value) => entry.id === 'part')).toEqual({ id: 'part', parentId: null, name: 'Participation', kind: 'participation', nature: 'regular',
      weight: null, weightUnsourced: true, score: null, maxScore: null, due: null, status: 'unknown', scoring: 'none', rule: null, ruleUnsourced: true });
  });

  it('filters by IDs or kind and reports unknown IDs', () => {
    expect(ok('get_assessments', { courseId: 'syn-1', ids: ['exam', 'q2'] }).assessments.map((entry: Value) => entry.id)).toEqual(['q2', 'exam']);
    expect(ok('get_assessments', { courseId: 'syn-1', kind: 'test' }).assessments.map((entry: Value) => entry.id)).toEqual(['alt', 'exam']);
    const error = failure('get_assessments', { courseId: 'syn-1', ids: ['exam', 'nope'] });
    expect(error.code).toBe('UNKNOWN_ASSESSMENT');
    expect(error.message).toContain('nope');
  });

  it('reads a version 1 document', () => {
    const v1: CourseDocument = { version: 1, course: { id: 'syn-2', code: 'SYN20002', name: 'Synthetic SYN20002', term: null }, materials: [],
      assessments: [{ id: 'e', name: 'Exam', kind: 'test', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: '2026-11-01T00:30:00Z', status: 'unknown', scoring: 'none', rule: null, sources: [] }] };
    expect(ok('get_assessments', { courseId: 'syn-2' }, context({ documents: [toDisplayDocument(v1)] })).assessments).toEqual([
      // Daylight saving time has started by November.
      { id: 'e', parentId: null, name: 'Exam', kind: 'test', nature: 'regular', weight: null, score: null, maxScore: null, due: '2026-11-01 11:30', status: 'unknown', scoring: 'none', rule: null },
    ]);
  });
});

describe('calculate_grades', () => {
  it('counts a leaf and a points group and gives a reason for everything else', () => {
    expect(ok('calculate_grades', { courseId: 'syn-1' })).toEqual({
      courseId: 'syn-1', code: 'SYN10001', gradedWeight: 50, earned: 36, average: 72, remainingWeight: 50, identifiedWeight: 100,
      counted: [{ id: 'a1', name: 'Assignment 1', weight: 20, earned: 15 }, { id: 'quizzes', name: 'Weekly quizzes', weight: 30, earned: 21 }],
      excluded: [
        { id: 'bonus', name: 'Bonus challenge', reason: 'bonus' }, { id: 'alt', name: 'Alternative exam', reason: 'alternative' },
        { id: 'part', name: 'Participation', reason: 'no-weight' }, { id: 'reflection', name: 'Reflection', reason: 'zero-weight' },
        { id: 'a2', name: 'Assignment 2', reason: 'no-weight' }, { id: 'exam', name: 'Final exam', reason: 'no-mark' },
        { id: 'hurdle', name: 'Lab attendance', reason: 'ungraded' },
      ],
      whatIfApplied: [],
    });
  });

  it('applies a what-if mark to a copy only', () => {
    const ctx = context();
    const result = ok('calculate_grades', { courseId: 'syn-1', whatIf: [{ assessmentId: 'exam', percent: 70 }] }, ctx);
    expect(result).toMatchObject({ gradedWeight: 100, earned: 71, average: 71, remainingWeight: 0 });
    expect(result.counted.at(-1)).toEqual({ id: 'exam', name: 'Final exam', weight: 50, earned: 35 });
    expect(result.whatIfApplied).toEqual([{ assessmentId: 'exam', percent: 70, effect: 'counted' }]);
    expect(ctx.documents[0].assessments.find(entry => entry.id === 'exam')?.score).toBeNull();
    expect(ok('calculate_grades', { courseId: 'syn-1' }, ctx).gradedWeight).toBe(50);
  });

  it('uses the percentage as a score out of 100 when the item has no maximum, on a leaf or a parent', () => {
    const doc = course('syn-3', 'SYN30003', [
      item({ id: 'essay', name: 'Essay', weight: 40 }),
      item({ id: 'labs', name: 'Labs', weight: 20, scoring: 'none' }), item({ id: 'l1', name: 'Lab 1', parentId: 'labs' }),
    ]);
    const result = ok('calculate_grades', { courseId: 'syn-3', whatIf: [{ assessmentId: 'essay', percent: 65 }, { assessmentId: 'labs', percent: 90 }] }, one(doc));
    expect(result).toMatchObject({ gradedWeight: 60, earned: 44 });
    expect(result.counted).toEqual([{ id: 'essay', name: 'Essay', weight: 40, earned: 26 }, { id: 'labs', name: 'Labs', weight: 20, earned: 18 }]);
    expect(result.whatIfApplied.map((entry: Value) => entry.effect)).toEqual(['counted', 'counted']);
  });

  it('completes a group from a what-if child, or says why it cannot change the total', () => {
    const doc = course('syn-3', 'SYN30003', [
      item({ id: 'quizzes', name: 'Quizzes', kind: 'quiz', weight: 10, scoring: 'points' }),
      item({ id: 'q1', name: 'Quiz 1', kind: 'quiz', parentId: 'quizzes', score: 4, maxScore: 5 }),
      item({ id: 'q2', name: 'Quiz 2', kind: 'quiz', parentId: 'quizzes', maxScore: 5 }),
      item({ id: 'q3', name: 'Quiz 3', kind: 'quiz', parentId: 'quizzes', maxScore: 5 }),
      item({ id: 'project', name: 'Project', weight: 30, score: 24, maxScore: 30, scoring: 'points' }),
      item({ id: 'p1', name: 'Milestone', parentId: 'project', maxScore: 10 }),
      item({ id: 'part', name: 'Participation', kind: 'participation' }),
      item({ id: 'zero', name: 'Practice', weight: 0 }),
    ]);
    const base = ok('calculate_grades', { courseId: 'syn-3' }, one(doc));
    expect(base).toMatchObject({ gradedWeight: 30, earned: 24 });
    expect(base.excluded.filter((entry: Value) => ['quizzes', 'q1', 'q2', 'q3'].includes(entry.id)).map((entry: Value) => entry.reason)).toEqual(['incomplete-group', 'incomplete-group', 'incomplete-group', 'incomplete-group']);
    const partial = ok('calculate_grades', { courseId: 'syn-3', whatIf: [{ assessmentId: 'q2', percent: 100 }, { assessmentId: 'p1', percent: 50 }, { assessmentId: 'part', percent: 80 }, { assessmentId: 'zero', percent: 80 }] }, one(doc));
    expect(partial).toMatchObject({ gradedWeight: 30, earned: 24 });
    expect(partial.whatIfApplied).toEqual([
      { assessmentId: 'q2', percent: 100, effect: 'none', reason: 'group-incomplete' },
      { assessmentId: 'p1', percent: 50, effect: 'none', reason: 'parent-score-overrides' },
      { assessmentId: 'part', percent: 80, effect: 'none', reason: 'no-weight' },
      { assessmentId: 'zero', percent: 80, effect: 'none', reason: 'zero-weight' },
    ]);
    const full = ok('calculate_grades', { courseId: 'syn-3', whatIf: [{ assessmentId: 'q2', percent: 100 }, { assessmentId: 'q3', percent: 60 }] }, one(doc));
    // (4 + 5 + 3) / 15 of 10%.
    expect(full).toMatchObject({ gradedWeight: 40, earned: 32 });
    expect(full.whatIfApplied.map((entry: Value) => entry.effect)).toEqual(['counted', 'counted']);
  });

  it('reports a zero-weight child of a counted group as not counted', () => {
    const doc = course('syn-3', 'SYN30003', [
      item({ id: 'quizzes', name: 'Quizzes', kind: 'quiz', weight: 30, scoring: 'points' }),
      item({ id: 'q1', name: 'Quiz 1', kind: 'quiz', parentId: 'quizzes', score: 8, maxScore: 10 }),
      item({ id: 'q0', name: 'Practice quiz', kind: 'quiz', parentId: 'quizzes', weight: 0, maxScore: 10 }),
    ]);
    const result = ok('calculate_grades', { courseId: 'syn-3', whatIf: [{ assessmentId: 'q0', percent: 100 }] }, one(doc));
    expect(result).toMatchObject({ gradedWeight: 30, earned: 24 });
    expect(result.excluded).toEqual([{ id: 'q0', name: 'Practice quiz', reason: 'zero-weight' }]);
    expect(result.whatIfApplied).toEqual([{ assessmentId: 'q0', percent: 100, effect: 'none', reason: 'zero-weight' }]);
  });

  it('counts a weighted group once every weighted child has a mark', () => {
    const doc = course('syn-3', 'SYN30003', [
      item({ id: 'labs', name: 'Labs', weight: 10, scoring: 'weighted' }),
      item({ id: 'l1', name: 'Lab 1', parentId: 'labs', weight: 4, score: 5, maxScore: 10 }),
      item({ id: 'l2', name: 'Lab 2', parentId: 'labs', weight: 6, maxScore: 10 }),
    ]);
    const before = ok('calculate_grades', { courseId: 'syn-3' }, one(doc));
    expect(before.counted).toEqual([{ id: 'l1', name: 'Lab 1', weight: 4, earned: 2 }]);
    const after = ok('calculate_grades', { courseId: 'syn-3', whatIf: [{ assessmentId: 'l2', percent: 50 }] }, one(doc));
    expect(after.counted).toEqual([{ id: 'labs', name: 'Labs', weight: 10, earned: 5 }]);
    expect(after.whatIfApplied).toEqual([{ assessmentId: 'l2', percent: 50, effect: 'counted' }]);
  });

  it('rejects a what-if on a bonus, ungraded or alternative item and an unknown ID', () => {
    for (const id of ['bonus', 'hurdle', 'alt']) {
      const error = failure('calculate_grades', { courseId: 'syn-1', whatIf: [{ assessmentId: id, percent: 50 }] });
      expect(error.code).toBe('INVALID_ARGUMENTS');
      expect(error.message).toContain(`whatIf.0.assessmentId: ${id}`);
    }
    expect(failure('calculate_grades', { courseId: 'syn-1', whatIf: [{ assessmentId: 'exam', percent: 50 }, { assessmentId: 'exam', percent: 60 }] }).code).toBe('INVALID_ARGUMENTS');
    expect(failure('calculate_grades', { courseId: 'syn-1', whatIf: [{ assessmentId: 'ghost', percent: 50 }] }).code).toBe('UNKNOWN_ASSESSMENT');
  });

  it('reports no average when nothing is graded', () => {
    const doc = course('syn-3', 'SYN30003', [item({ id: 'exam', name: 'Exam', weight: 100 })]);
    expect(ok('calculate_grades', { courseId: 'syn-3' }, one(doc))).toMatchObject({ gradedWeight: 0, earned: 0, average: null, remainingWeight: 100 });
  });
});

describe('final_needed', () => {
  const forty = course('syn-4', 'SYN40004', [item({ id: 'mid', name: 'Midsemester test', kind: 'test', weight: 40, score: 30, maxScore: 40 })]);
  const planning = (targets: PlanningSnapshot['targets']): PlanningSnapshot => ({ tasks: [], availability: [120, 120, 120, 120, 120, 120, 120], targets });

  it('uses the saved target from the planning snapshot', () => {
    expect(ok('final_needed', { courseId: 'syn-4' }, one(forty, { planning: planning({ 'syn-4': 'H2A' }) }))).toEqual({
      courseId: 'syn-4', code: 'SYN40004', target: { band: 'H2A', percent: 75, source: 'saved' }, status: 'reachable', neededAverage: 75,
      earned: 30, gradedWeight: 40, remainingWeight: 60, unidentifiedWeight: 60, whatIfApplied: [],
    });
  });

  it('defaults to H1 when nothing is saved or given', () => {
    expect(ok('final_needed', { courseId: 'syn-4' }, one(forty)).target).toEqual({ band: 'H1', percent: 80, source: 'default' });
    expect(ok('final_needed', { courseId: 'syn-4' }, one(forty, { planning: planning({ 'syn-1': 'P' }) })).target).toEqual({ band: 'H1', percent: 80, source: 'default' });
  });

  it('prefers a target given as an argument, as a band or a percentage', () => {
    const ctx = one(forty, { planning: planning({ 'syn-4': 'H2A' }) });
    expect(ok('final_needed', { courseId: 'syn-4', target: 'P' }, ctx)).toMatchObject({ target: { band: 'P', percent: 50, source: 'argument' }, status: 'reachable', neededAverage: 33.33 });
    expect(ok('final_needed', { courseId: 'syn-4', target: 72.5 }, ctx).target).toEqual({ percent: 72.5, source: 'argument' });
  });

  it('reports secured and unreachable targets without a needed average', () => {
    expect(ok('final_needed', { courseId: 'syn-1', target: 30 })).toMatchObject({ status: 'secured', earned: 36 });
    expect(ok('final_needed', { courseId: 'syn-1', target: 30 })).not.toHaveProperty('neededAverage');
    expect(ok('final_needed', { courseId: 'syn-1' })).toMatchObject({ status: 'reachable', neededAverage: 88, unidentifiedWeight: 0 });
    const result = ok('final_needed', { courseId: 'syn-1', whatIf: [{ assessmentId: 'exam', percent: 10 }] });
    expect(result).toMatchObject({ status: 'unreachable', earned: 41, gradedWeight: 100, remainingWeight: 0 });
    expect(result.whatIfApplied).toEqual([{ assessmentId: 'exam', percent: 10, effect: 'counted' }]);
  });
});

describe('upcoming_deadlines', () => {
  it('lists unfinished items due in the window, sorted by due date', () => {
    expect(ok('upcoming_deadlines', {})).toEqual({
      today: '2026-09-14', from: '2026-09-14', to: '2026-09-27',
      items: [
        { courseId: 'syn-1', code: 'SYN10001', id: 'a2', name: 'Assignment 2', due: '2026-09-16 23:59', weight: null, status: 'not_started' },
        { courseId: 'syn-1', code: 'SYN10001', id: 'hurdle', name: 'Lab attendance', due: '2026-09-20', weight: null, status: 'in_progress' },
      ],
      notSynced: ['syn-2'],
    });
  });

  it('includes submitted and graded items only when asked', () => {
    const ids = (args: object) => ok('upcoming_deadlines', args).items.map((entry: Value) => entry.id);
    expect(ids({ includeDone: true })).toEqual(['reflection', 'a2', 'hurdle']);
    expect(ids({ days: 2 })).toEqual([]);
    expect(ids({ days: 2, includeDone: true })).toEqual(['reflection']);
    expect(ids({ days: 120 })).toEqual(['a2', 'hurdle', 'exam']);
    expect(failure('upcoming_deadlines', { days: 121 }).code).toBe('INVALID_ARGUMENTS');
  });

  it('limits the courses to the given scope IDs', () => {
    expect(ok('upcoming_deadlines', { courseIds: ['syn-2'] })).toEqual({ today: '2026-09-14', from: '2026-09-14', to: '2026-09-27', items: [], notSynced: ['syn-2'] });
    expect(failure('upcoming_deadlines', { courseIds: ['syn-9'] }).code).toBe('COURSE_NOT_IN_SCOPE');
  });

  it('caps the list at 50 items', () => {
    const many = course('syn-3', 'SYN30003', Array.from({ length: 60 }, (_, index) => item({ id: `t${String(index).padStart(2, '0')}`, name: `Task ${index}`, due: '2026-09-15' })));
    const result = ok('upcoming_deadlines', {}, one(many));
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toMatchObject({ field: 'items', shown: 50, total: 60 });
    expect(result.truncated.hint).toMatch(/days|courseIds/);
  });
});

describe('plan_schedule', () => {
  const flat = (minutes: number) => Array<number>(7).fill(minutes);
  const task = (key: string, courseId: string, due: string, minutes: number, extra: object = {}) => ({ key, title: `Synthetic ${key}`, courseId, courseCode: courseId ? courseId.toUpperCase() : '', due, minutes, ...extra });

  it('plans the snapshot tasks from today', () => {
    const planning: PlanningSnapshot = { tasks: [task('task:read', 'syn-1', '2026-09-16', 180)], availability: flat(120), targets: {} };
    const result = ok('plan_schedule', {}, context({ planning }));
    expect(result).toMatchObject({ available: true, today: '2026-09-14', from: '2026-09-14', to: '2026-09-20', tasksSource: 'snapshot', availabilitySource: 'snapshot', overflow: [] });
    expect(Object.keys(result.days)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
    expect(result.days['2026-09-14']).toEqual([{ key: 'task:read', title: 'Synthetic task:read', courseCode: 'SYN-1', minutes: 120 }]);
    expect(result.days['2026-09-15']).toEqual([{ key: 'task:read', title: 'Synthetic task:read', courseCode: 'SYN-1', minutes: 60 }]);
    expect(result.days['2026-09-16']).toEqual([]);
  });

  it('filters the output by course without changing the placements of the weekly page', () => {
    const tasks = [task('syn-1:a2', 'syn-1', '2026-09-16', 150), task('task:x', 'syn-2', '2026-09-16', 150)];
    const page = schedulePlan(tasks, flat(120), '2026-09-14');
    const result = ok('plan_schedule', { courseIds: ['syn-2'] }, context({ planning: { tasks, availability: flat(120), targets: {} } }));
    for (const [day, blocks] of Object.entries(result.days) as [string, { key: string; minutes: number }[]][]) {
      expect(blocks.map(block => ({ key: block.key, minutes: block.minutes }))).toEqual((page.days[day] ?? []).filter(block => block.key === 'task:x'));
    }
    expect(result.days['2026-09-15']).toEqual([{ key: 'task:x', title: 'Synthetic task:x', courseCode: 'SYN-2', minutes: 90 }]);
    expect(result.days['2026-09-16']).toEqual([{ key: 'task:x', title: 'Synthetic task:x', courseCode: 'SYN-2', minutes: 60 }]);
  });

  it('shows scope courses and personal tasks by default, while planning every snapshot task', () => {
    const tasks = [task('a', 'syn-1', '2026-09-14', 60), task('b', 'syn-7', '2026-09-14', 60), task('c', '', '2026-09-14', 60)];
    const result = ok('plan_schedule', { days: 1 }, context({ scope: ['syn-1'], planning: { tasks, availability: flat(150), targets: {} } }));
    expect(result.days['2026-09-14'].map((block: Value) => [block.key, block.minutes])).toEqual([['a', 60], ['c', 30]]);
    expect(result.overflow).toEqual([{ key: 'c', title: 'Synthetic c', courseCode: '', minutes: 30, overdue: false }]);
    expect(failure('plan_schedule', { courseIds: ['syn-7'] }, context({ scope: ['syn-1'], planning: { tasks, availability: flat(150), targets: {} } })).code).toBe('COURSE_NOT_IN_SCOPE');
  });

  it('plans argument tasks, keeping their keys or numbering them, with the chosen availability', () => {
    const args = { tasks: [{ title: 'Revise', due: '2026-09-15', minutes: 90 }, { key: 'mine', title: 'Draft', courseId: 'syn-1', courseCode: 'SYN10001', due: '2026-09-14', minutes: 30 }, { title: 'Late', due: '2026-09-13', minutes: 20, spent: 5 }], days: 2 };
    const result = ok('plan_schedule', args, context({ planning: { tasks: [task('snap', 'syn-1', '2026-09-14', 999)], availability: flat(60), targets: {} } }));
    expect(result).toMatchObject({ tasksSource: 'argument', availabilitySource: 'snapshot' });
    expect(result.days).toEqual({
      '2026-09-14': [{ key: 'mine', title: 'Draft', courseCode: 'SYN10001', minutes: 30 }, { key: 'arg:1', title: 'Revise', courseCode: '', minutes: 30 }],
      '2026-09-15': [{ key: 'arg:1', title: 'Revise', courseCode: '', minutes: 60 }],
    });
    expect(result.overflow).toEqual([{ key: 'arg:3', title: 'Late', courseCode: '', minutes: 15, overdue: true }]);
    expect(ok('plan_schedule', { ...args, availability: flat(30) }).availabilitySource).toBe('argument');
    expect(ok('plan_schedule', args).availabilitySource).toBe('default');
    expect(failure('plan_schedule', { tasks: [{ key: 'k', title: 'A', due: '2026-09-15', minutes: 5 }, { key: 'k', title: 'B', due: '2026-09-15', minutes: 5 }] }).code).toBe('INVALID_ARGUMENTS');
  });

  it('returns only the requested window', () => {
    const planning: PlanningSnapshot = { tasks: [task('t', 'syn-1', '2026-09-20', 600)], availability: flat(60), targets: {} };
    const result = ok('plan_schedule', { from: '2026-09-17', days: 2 }, context({ planning }));
    expect(result.days).toEqual({ '2026-09-17': [{ key: 't', title: 'Synthetic t', courseCode: 'SYN-1', minutes: 60 }], '2026-09-18': [{ key: 't', title: 'Synthetic t', courseCode: 'SYN-1', minutes: 60 }] });
    expect(failure('plan_schedule', { from: '2026-09-13' }, context({ planning })).message).toMatch(/^from: /);
    expect(failure('plan_schedule', { days: 29 }, context({ planning })).code).toBe('INVALID_ARGUMENTS');
  });

  it('says planning is not available without tasks or a snapshot', () => {
    const result = ok('plan_schedule', {});
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/pass tasks/);
    expect(result).not.toHaveProperty('days');
  });
});

describe('output limit', () => {
  it('cuts the largest list and says how to get the rest', () => {
    const big = course('syn-3', 'SYN30003', Array.from({ length: 200 }, (_, index) => item({ id: `item-${index}`, name: `Synthetic assessment number ${index}`, weight: 0.5, rule: 'Submitted online' })));
    const result = runTool('get_assessments', { courseId: 'syn-3' }, one(big));
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(RESULT_LIMIT);
    const value = result.value as Value;
    expect(value.truncated).toMatchObject({ field: 'assessments', total: 200 });
    expect(value.truncated.shown).toBe(value.assessments.length);
    expect(value.truncated.shown).toBeGreaterThan(10);
    expect(value.truncated.hint).toMatch(/ids/);
    expect(value.truncated.hint).toMatch(/kind/);
    // The cut keeps as many items as fit.
    expect(JSON.stringify({ ...value, assessments: [...value.assessments, value.assessments[0]] }).length).toBeGreaterThan(RESULT_LIMIT);
  });

  it('returns RESULT_TOO_LARGE when nothing fits', () => {
    const huge = course('syn-3', 'SYN30003', [item({ id: 'x', name: 'Huge', rule: 'r'.repeat(9000) })]);
    const error = failure('get_assessments', { courseId: 'syn-3' }, one(huge));
    expect(error.code).toBe('RESULT_TOO_LARGE');
  });
});
