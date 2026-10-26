import { afterEach, describe, expect, it } from 'vitest';
import { projectGrade } from '../../src/domain/grade.js';
import type { CourseSelection } from '../../src/domain/schemas.js';
import type { ItemsClassifyInput } from '../../src/protocol/sync.js';
import { canvasApiUrl, type CanvasAssignmentValue, type GroupsStage } from '../../src/sync/canvas-api.js';
import { buildCourseDocument, classificationRetryIds, type BuildDocumentResult } from '../../src/sync/build-document.js';
import { reconcileConflicts } from '../../src/sync/conflicts.js';
import { assessmentId, componentAssessmentId, importCourseDocument, remainderAssessmentId } from '../../src/sync/course-import.js';
import { validateCourseDocument } from '../../src/sync/course-json.js';
import type { SkeletonStage } from '../../src/sync/handbook.js';
import { collectWork } from '../../src/planning/work.js';
import { SqliteRepository } from '../../src/store/sqlite.js';

const now = '2026-10-24T01:00:00Z';
const code = 'SYNA10001';
const term = '2026:S2';
const key = `${code}:${term}`;
const canvasPage = 'https://canvas.lms.unimelb.edu.au/courses/900001';
const edPage = 'https://edstem.org/au/courses/800001';
const groupsSource = canvasApiUrl('groups', '900001');
const handbookSource = 'https://handbook.unimelb.edu.au/2026/subjects/syna10001/assessment';

const course: CourseSelection = { key, code, name: 'Synthetic Systems', term, pages: { canvas: canvasPage, ed: edPage },
  offeredAt: now, selected: true };
const assignmentUrl = (id: string) => `${canvasPage}/assignments/${id}`;
const apiValue = <T>(value: T) => ({ value, state: 'found' as const, via: 'api' as const, source: groupsSource });
const unknown = { value: null, state: 'unknown' as const, checkedAt: now };

interface SyntheticAssignment { id: string; name: string; weight?: number }
interface SyntheticGroup { name: string; weight: number; items: SyntheticAssignment[] }

/** A Canvas groups stage with synthetic items; every number is invented. */
function groupsStage(groups: SyntheticGroup[]): GroupsStage {
  return { source: groupsSource, via: 'api', coverage: 'api', unweighted: groups.every(group => group.weight === 0),
    groups: groups.map((entry, index) => {
      const value = { id: String(501 + index), name: entry.name, weight: apiValue(entry.weight) };
      return { ...value, assignments: entry.items.map((item): CanvasAssignmentValue => {
        const assignment: CanvasAssignmentValue = { id: item.id, name: item.name, courseId: '900001', assignmentGroupId: value.id,
          htmlUrl: assignmentUrl(item.id), group: { ...value, weight: { ...value.weight } },
          due: apiValue('2026-10-31T12:59:00Z'), unlockAt: apiValue('2026-10-01T00:00:00Z'), outOf: apiValue(10),
          score: { value: null, state: 'unknown', checkedAt: now }, status: apiValue('not_started' as const),
          updatedAt: apiValue('2026-10-20T08:00:00Z') };
        // A synthetic item weight stands in for a stated item weight the Canvas groups page does not carry.
        return item.weight === undefined ? assignment : { ...assignment, weight: apiValue(item.weight) } as CanvasAssignmentValue;
      }) };
    }) };
}

function skeletonStage(components: { name: string; weight?: number; hurdle?: string }[]): SkeletonStage {
  return { source: handbookSource, via: 'handbook', components: components.map(component => ({
    name: component.name, ...(component.weight !== undefined ? { weight: component.weight } : {}),
    ...(component.hurdle ? { hurdle: component.hurdle } : {}),
    quote: `${component.name}\tSynthetic timing\t${component.weight ?? 0}%`,
  })) };
}

function classification(items: ItemsClassifyInput['items']): ItemsClassifyInput {
  return { jobId: 'synthetic-job', courseKey: key, items };
}

/** A synthetic CLI Ed stage: only the fields the build reads, with invented ids and titles. */
function edApiStage(lessons: { id: string; title: string; dueAt: string | null; module?: string }[]) {
  return { via: 'api' as const, source: 'edstem-cli' as const, unitId: 4101, files: [],
    lessons: lessons.map(lesson => ({ id: lesson.id, title: lesson.title, module: lesson.module ?? 'Synthetic module',
      dueAt: lesson.dueAt, url: `https://edstem.org/au/courses/800001/lessons/${lesson.id}` })) };
}

/** A synthetic fallback Ed page stage; the quote is invented page text. */
function edPageStage(lessons: { title: string; dueAt?: string }[]) {
  return { via: 'ax' as const, source: 'edstem-page' as const,
    lessons: lessons.map(lesson => ({ title: lesson.title, ...(lesson.dueAt ? { dueAt: lesson.dueAt } : {}),
      quote: `Synthetic quote for ${lesson.title}` })) };
}

const assignmentStage = (id: string, policy: 'allowed' | 'prohibited' | 'unknown' = 'allowed') =>
  ({ policy: { value: policy, ...(policy === 'unknown' ? {} : { quote: 'Generative AI is allowed for this task.' }) }, files: [] });

function build(stages: Record<string, unknown>, resolved?: Parameters<typeof buildCourseDocument>[0]['resolved']) {
  return buildCourseDocument({ course, stages, now, ...(resolved ? { resolved } : {}) });
}

const stores: SqliteRepository[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function save(result: ReturnType<typeof build>) {
  const checked = validateCourseDocument(result.document, { final: true, now });
  expect(checked.fatal).toBe(false);
  expect(checked.document).toBeDefined();
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const receipt = importCourseDocument(store, checked.document!, { at: now });
  reconcileConflicts(store, receipt.courseId, result.conflicts, now, result.complete);
  return { store, receipt, checked };
}

describe('build the course document from the pipeline stages (layered-sync task 6.2)', () => {
  it('builds course fields, components and items with API facts and Handbook weights', () => {
    const result = build({
      skeleton: skeletonStage([
        { name: 'Assignments', weight: 30 },
        { name: 'Final exam', weight: 50 },
        { name: 'Participation', weight: 0, hurdle: 'Students must attend at least 80% of tutorials.' },
      ]),
      groups: groupsStage([
        { name: 'Assignments', weight: 30, items: [{ id: '1', name: 'Synthetic Assignment 1' }] },
        { name: 'Participation', weight: 0, items: [{ id: '2', name: 'Synthetic Attendance' }] },
        { name: 'Final exam', weight: 50, items: [{ id: '4', name: 'Synthetic Final Exam' }] },
        { name: 'Synthetic Practice', weight: 0, items: [{ id: '3', name: 'Synthetic Practice Quiz' }] },
      ]),
      classification: classification([
        { id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' },
        { id: '2', category: 'participation', component: 'Participation', evidence: 'Synthetic group name' },
        { id: '3', category: 'quiz', evidence: 'Synthetic practice group name' },
        { id: '4', category: 'exam', component: 'Final exam', evidence: 'Synthetic group name' },
      ]),
      'assignments.1': assignmentStage('1', 'allowed'),
      map: { lms: { text: 'Synthetic', quote: 'Synthetic' }, ed: { text: 'Synthetic', quote: 'Synthetic' },
        syllabus: { where: 'unknown' }, links: [], aiPolicy: { value: 'prohibited', quote: 'No generative AI for this course.' } },
    });

    expect(result.complete).toBe(true);
    expect(result.conflicts).toEqual([]);
    const document = result.document;
    expect(document.course).toMatchObject({ code: { value: code }, name: { value: 'Synthetic Systems' },
      term: { value: term }, pages: { canvas: canvasPage, ed: edPage }, platforms: { canvas: 'read', ed: 'absent' },
      componentsComplete: true });
    expect(document.course.aiPolicy).toMatchObject({ value: 'prohibited', state: 'found', via: 'ax',
      quote: 'No generative AI for this course.', source: canvasPage });

    const assignments = document.components.find(component => component.key === `${code}:assignments`)!;
    expect(assignments).toMatchObject({ kind: { value: 'assignment' }, count: { value: 1 },
      weight: { value: 30, state: 'found', via: 'api', source: groupsSource }, isFinal: { value: false } });
    expect(assignments.weight).not.toHaveProperty('quote');
    expect(assignments.hurdleMin).toMatchObject({ value: null, state: 'not_applicable' });

    const exam = document.components.find(component => component.key === `${code}:final-exam`)!;
    expect(exam).toMatchObject({ kind: { value: 'exam' }, count: { value: 1 },
      isFinal: { value: true }, weight: { value: 50, state: 'found', via: 'api', source: groupsSource } });

    const participation = document.components.find(component => component.key === `${code}:participation`)!;
    expect(participation).toMatchObject({ kind: { value: 'participation' }, weight: { value: 0, via: 'handbook' },
      hurdleMin: { value: 80, state: 'found', via: 'handbook', source: handbookSource,
        quote: 'Students must attend at least 80% of tutorials.' } });

    const ungraded = document.components.find(component => component.key === `${code}:ungraded`)!;
    expect(ungraded).toMatchObject({ name: { value: 'Ungraded' }, kind: { value: 'ungraded' }, weight: { value: 0 } });
    expect(ungraded.items.map(item => item.kind?.value)).toEqual(['ungraded']);

    const item = assignments.items[0]!;
    expect(item).toMatchObject({ key: `${code}:canvas:assignment:1`, name: { value: 'Synthetic Assignment 1' },
      url: assignmentUrl('1'), kind: { value: 'assignment' }, due: { value: '2026-10-31T12:59:00Z', via: 'api', source: groupsSource },
      unlockAt: { value: '2026-10-01T00:00:00Z', via: 'api', source: groupsSource },
      outOf: { value: 10, via: 'api', source: groupsSource }, status: { value: 'not_started', via: 'api', source: groupsSource },
      weight: { value: null, state: 'unknown' },
      aiPolicy: { value: 'allowed', state: 'found', via: 'ax', quote: 'Generative AI is allowed for this task.', source: assignmentUrl('1') } });
    expect(item.due).not.toHaveProperty('quote');
    expect(item.score).toMatchObject({ value: null, state: 'unknown' });
  });

  it('greys out items the grading rule rejects and stores the weight-0 group conflict', () => {
    const result = build({
      skeleton: skeletonStage([{ name: 'Assignments', weight: 30 },
        { name: 'Participation', weight: 0, hurdle: 'Students must attend at least 80% of tutorials.' }]),
      groups: groupsStage([
        { name: 'Synthetic Survey', weight: 0, items: [{ id: '700001', name: 'Token Use: Assignment 1 Extensions' }] },
        { name: 'Synthetic Practice', weight: 0, items: [{ id: '700002', name: 'Synthetic Practice Quiz' }] },
        { name: 'Synthetic Assignments', weight: 0, items: [{ id: '700003', name: 'Synthetic Assignment 1' }] },
        { name: 'Synthetic Participation', weight: 0, items: [{ id: '700004', name: 'Synthetic Attendance' }] },
      ]),
      classification: classification([
        { id: '700001', category: 'quiz', evidence: 'Synthetic survey group name' },
        { id: '700002', category: 'quiz', evidence: 'Synthetic practice group name' },
        { id: '700003', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' },
        { id: '700004', category: 'participation', component: 'Participation', evidence: 'Synthetic group name' },
      ]),
    });
    expect(result.conflicts).toEqual([{ field: 'weight', componentKey: `${code}:assignments`, skeletonValue: 30, canvasValue: 0 }]);

    const saved = save(result);
    const get = (savedCode: string) => saved.store.loadAssessment(assessmentId(term, `${code}:canvas:assignment:${savedCode}`));
    expect(get('700001')).toMatchObject({ kind: 'ungraded', weight: 0 });
    expect(get('700002')).toMatchObject({ kind: 'ungraded', weight: 0 });
    expect(get('700003')).toMatchObject({ kind: 'assignment', weight: 30, group: { key: `${code}:assignments` } });
    expect(saved.store.loadAssessment(componentAssessmentId(term, `${code}:participation`))).toMatchObject({
      kind: 'participation', weight: 0, hurdleMin: 80,
    });
    expect(get('700004')).toBeUndefined();
    expect(saved.store.listSyncConflicts(saved.receipt.courseId)).toEqual([
      expect.objectContaining({ field: 'weight', state: 'open', skeletonValue: 30, canvasValue: 0,
        target: { componentKey: `${code}:assignments` } }),
    ]);
  });

  it('keeps the import split: even shares without stated weights and what remains beside a stated weight', () => {
    const even = build({
      skeleton: skeletonStage([{ name: 'Work', weight: 20 }]),
      groups: groupsStage([{ name: 'Work', weight: 20, items: [
        { id: '1', name: 'Synthetic item 1' }, { id: '2', name: 'Synthetic item 2' }, { id: '3', name: 'Synthetic item 3' },
      ] }]),
      classification: classification([
        { id: '1', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' },
        { id: '2', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' },
        { id: '3', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' },
      ]),
    });
    expect(even.document.components[0]!.items.map(item => item.weight.state)).toEqual(['unknown', 'unknown', 'unknown']);
    const evenSaved = save(even);
    expect([1, 2, 3].map(id => evenSaved.store.loadAssessment(assessmentId(term, `${code}:canvas:assignment:${id}`))?.weight))
      .toEqual([20 / 3, 20 / 3, 20 / 3]);
    expect(evenSaved.store.loadAssessment(assessmentId(term, `${code}:canvas:assignment:1`))?.readState?.weight)
      .toEqual({ state: 'derived' });
    expect(evenSaved.store.loadAssessment(remainderAssessmentId(term, `${code}:work`))).toBeUndefined();

    const split = build({
      skeleton: skeletonStage([{ name: 'Work', weight: 20 }]),
      groups: groupsStage([{ name: 'Work', weight: 20, items: [
        { id: '1', name: 'Synthetic item 1', weight: 10 }, { id: '2', name: 'Synthetic item 2' }, { id: '3', name: 'Synthetic item 3' },
      ] }]),
      classification: classification([
        { id: '1', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' },
        { id: '2', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' },
        { id: '3', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' },
      ]),
    });
    expect(split.document.components[0]!.items[0]!.weight).toMatchObject({ value: 10, state: 'found', via: 'api' });
    const splitSaved = save(split);
    expect([1, 2, 3].map(id => splitSaved.store.loadAssessment(assessmentId(term, `${code}:canvas:assignment:${id}`))?.weight))
      .toEqual([10, 5, 5]);
  });

  it('puts ungraded items in one component and leaves a graded item without a component unmatched', () => {
    const result = build({
      skeleton: skeletonStage([{ name: 'Assignments', weight: 30 }]),
      groups: groupsStage([
        { name: 'Synthetic Weighted', weight: 20, items: [{ id: '9', name: 'Synthetic Report' }] },
        { name: 'Synthetic Survey', weight: 0, items: [{ id: '8', name: 'Synthetic Survey' }] },
      ]),
      classification: classification([
        { id: '9', category: 'assignment', evidence: 'Synthetic weighted group name' },
        { id: '8', category: 'quiz', evidence: 'Synthetic survey group name' },
      ]),
    });
    expect(result.document.course.componentsComplete).toBe(false);
    const unassigned = result.document.components.find(component => component.key === `${code}:unassigned`)!;
    expect(unassigned).toMatchObject({ name: { value: 'Unassigned' }, weight: { value: null, state: 'unknown' } });
    expect(unassigned.items.map(item => item.key)).toEqual([`${code}:canvas:assignment:9`]);
    expect(result.conflicts).toEqual([{ field: 'unmatched', canvasAssignmentId: '9',
      canvasValue: { id: '9', name: 'Synthetic Report', due: '2026-10-31T12:59:00Z' } }]);
    expect(result.document.components.find(component => component.key === `${code}:ungraded`)!.items
      .map(item => item.key)).toEqual([`${code}:canvas:assignment:8`]);

    const saved = save(result);
    expect(saved.store.loadAssessment(assessmentId(term, `${code}:canvas:assignment:9`))).toMatchObject({ kind: 'assignment' });
    expect(saved.store.listSyncConflicts(saved.receipt.courseId)[0]).toMatchObject({ field: 'unmatched', state: 'open' });
  });

  it('reads the course AI policy from the home page map and leaves it unknown when the map has none', () => {
    const policy = build({ map: { links: [], aiPolicy: { value: 'allowed', quote: 'Generative AI is permitted.' } } });
    expect(policy.document.course.aiPolicy).toMatchObject({ value: 'allowed', state: 'found', via: 'ax',
      quote: 'Generative AI is permitted.', source: canvasPage });

    const missing = build({ map: { links: [] } });
    expect(missing.document.course.aiPolicy).toEqual({ value: null, state: 'unknown', checkedAt: now });
  });

  it('reports Canvas read, blocked or absent from the groups stage and the run record', () => {
    const groups = groupsStage([{ name: 'Work', weight: 20, items: [{ id: '1', name: 'Synthetic item 1' }] }]);
    expect(build({ groups }).document.course.platforms.canvas).toBe('read');
    expect(build({}, undefined).document.course.platforms.canvas).toBe('absent');
    expect(buildCourseDocument({ course, stages: {}, now, blocked: ['canvas'] }).document.course.platforms.canvas).toBe('blocked');
  });

  it('is complete only for a full groups stage and a skeleton covering every graded item', () => {
    const stages = {
      skeleton: skeletonStage([{ name: 'Work', weight: 20 }]),
      groups: groupsStage([{ name: 'Work', weight: 20, items: [{ id: '1', name: 'Synthetic item 1' }] }]),
      classification: classification([{ id: '1', category: 'assignment', component: 'Work', evidence: 'Synthetic group name' }]),
    };
    expect(build(stages).complete).toBe(true);
    expect(build({ ...stages, groups: { ...groupsStage([{ name: 'Work', weight: 20, items: [{ id: '1', name: 'Synthetic item 1' }] }]),
      coverage: 'partial' } }).complete).toBe(false);
    expect(build({ groups: stages.groups }).complete).toBe(true);
    expect(build({ groups: stages.groups }).document.course.componentsComplete).toBe(false);
  });

  it('counts item kinds the classifier left unknown even when the component kind is known', () => {
    const classifiedUngraded = build({
      skeleton: skeletonStage([{ name: 'Assignments', weight: 30 }]),
      groups: groupsStage([{ name: 'Work', weight: 30, items: [
        { id: '1', name: 'Synthetic item 1' }, { id: '2', name: 'Synthetic item 2' },
      ] }]),
      classification: classification([
        { id: '1', category: 'assignment', component: 'Assignments', evidence: 'Synthetic group name' },
        { id: '2', category: 'ungraded', component: 'Assignments', evidence: 'Synthetic group name' },
      ]),
    });
    expect(classifiedUngraded.document.components[0]).toMatchObject({ kind: { value: 'assignment' },
      items: [{ kind: { value: 'assignment' } }, { kind: { value: null, state: 'unknown' } }] });
    expect(classifiedUngraded.unknown).toContain('components[0].items[1].kind');

    // The Unassigned component's kind comes from item 1 while item 2 stays unclassified.
    const unassigned = build({
      skeleton: skeletonStage([{ name: 'Assignments', weight: 30 }]),
      groups: groupsStage([{ name: 'Work', weight: 30, items: [
        { id: '1', name: 'Synthetic item 1' }, { id: '2', name: 'Synthetic item 2' },
      ] }]),
      classification: classification([{ id: '1', category: 'assignment', component: 'Nowhere', evidence: 'Synthetic group name' }]),
    });
    const component = unassigned.document.components.find(entry => entry.key === `${code}:unassigned`)!;
    const componentIndex = unassigned.document.components.indexOf(component);
    expect(component).toMatchObject({ kind: { value: 'assignment' },
      items: [{ kind: { value: 'assignment' } }, { kind: { value: null, state: 'unknown' } }] });
    expect(unassigned.unknown).toContain(`components[${componentIndex}].items[1].kind`);
  });

  it('gives the synthetic components keys no Handbook component can take, renaming a colliding real component', () => {
    const result = build({
      skeleton: skeletonStage([{ name: 'Ungraded', weight: 10 }, { name: 'Unassigned', weight: 10 }]),
      groups: groupsStage([
        { name: 'Synthetic Practice', weight: 0, items: [{ id: '8', name: 'Synthetic practice' }] },
        { name: 'Synthetic Weighted', weight: 10, items: [{ id: '9', name: 'Synthetic report' }] },
      ]),
      classification: classification([{ id: '9', category: 'assignment', evidence: 'Synthetic weighted group name' }]),
    });
    expect(result.synthetic).toEqual({ ungraded: `${code}:ungraded`, unassigned: `${code}:unassigned` });
    expect(result.document.components.map(component => component.key)).toEqual(expect.arrayContaining([
      `${code}:ungraded`, `${code}:unassigned`, `${code}:ungraded-component`, `${code}:unassigned-component`,
    ]));
    expect(result.document.components.find(component => component.key === `${code}:ungraded-component`))
      .toMatchObject({ name: { value: 'Ungraded' }, items: [] });
    expect(result.document.components.find(component => component.key === `${code}:unassigned-component`))
      .toMatchObject({ name: { value: 'Unassigned' }, items: [] });
    expect(result.document.components.find(component => component.key === `${code}:ungraded`)!.items.map(item => item.key))
      .toEqual([`${code}:canvas:assignment:8`]);
    expect(result.document.components.find(component => component.key === `${code}:unassigned`)!.items.map(item => item.key))
      .toEqual([`${code}:canvas:assignment:9`]);
  });

  it('keeps a real "Ungraded" component on the same key whether or not this run has ungraded items', () => {
    const skeleton = skeletonStage([{ name: 'Ungraded', weight: 10 }]);
    const withUngraded = build({ skeleton, groups: groupsStage([{ name: 'Synthetic Practice', weight: 0, items: [{ id: '8', name: 'Synthetic practice' }] }]) });
    const without = build({ skeleton, groups: groupsStage([{ name: 'Synthetic Weighted', weight: 10, items: [{ id: '9', name: 'Synthetic report' }] }]),
      classification: classification([{ id: '9', category: 'assignment', component: 'Ungraded', evidence: 'Synthetic weighted group name' }]) });
    const realKey = (result: typeof without) => result.document.components.find(component => component.name.value === 'Ungraded' && !component.key.endsWith(':ungraded'))?.key
      ?? result.document.components.find(component => component.name.value === 'Ungraded')?.key;
    expect(realKey(withUngraded)).toBe(`${code}:ungraded-component`);
    expect(realKey(without)).toBe(`${code}:ungraded-component`);
  });

  it('identifies the synthetic ungraded component by its flag, not by a key suffix', () => {
    const syntheticKey = `${code}:ungraded`;
    const document = {
      components: [{ key: syntheticKey, kind: { value: 'ungraded', state: 'derived' },
        items: [{ key: `${code}:canvas:assignment:8`, kind: { value: null, state: 'unknown', checkedAt: now } }] }],
    } as unknown as BuildDocumentResult['document'];
    expect(classificationRetryIds({ document, synthetic: {} })).toEqual(['8']);
    expect(classificationRetryIds({ document, synthetic: { ungraded: syntheticKey } })).toEqual([]);
  });

  it('classifies two dated Ed lessons as quizzes in a weighted component, split evenly, with the weight-sum warning intact', () => {
    const result = build({
      skeleton: skeletonStage([{ name: 'Quizzes', weight: 10 }, { name: 'Exam', weight: 80 }]),
      ed: edApiStage([
        { id: '7001', title: 'Synthetic Ed quiz 1', dueAt: '2026-10-30T12:59:00Z' },
        { id: '7002', title: 'Synthetic Ed quiz 2', dueAt: '2026-11-06T12:59:00Z' },
      ]),
      classification: classification([
        { id: 'ed:7001', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic Ed lesson list' },
        { id: 'ed:7002', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic Ed lesson list' },
      ]),
    });
    const quizzes = result.document.components.find(component => component.key === `${code}:quizzes`)!;
    expect(quizzes.items.map(item => item.key)).toEqual([
      `${code}:ed:lesson:7001`, `${code}:ed:lesson:7002`,
    ]);
    expect(quizzes.items.map(item => item.kind?.value)).toEqual(['quiz', 'quiz']);
    expect(quizzes.items.map(item => item.weight)).toEqual([
      { value: 5, state: 'derived' }, { value: 5, state: 'derived' },
    ]);

    const saved = save(result);
    for (const lessonId of ['7001', '7002']) {
      expect(saved.store.loadAssessment(assessmentId(term, `${code}:ed:lesson:${lessonId}`)))
        .toMatchObject({ kind: 'quiz', weight: 5, group: { key: `${code}:quizzes` } });
    }
    const course = saved.store.loadCourse(saved.receipt.courseId)!;
    const assessments = saved.store.query('assessments', { limit: 50 }).items;
    const projection = projectGrade(course, assessments, 'H1');
    expect(typeof projection.gradedWeight).toBe('number');
    expect(Number.isFinite(projection.gradedWeight)).toBe(true);
    expect(saved.checked.warnings).toEqual([{ code: 'WEIGHT_SUM', sum: 90 }]);
  });

  it('stores an ungraded or unclassified dated Ed lesson as ungraded weight 0, outside planning, with no retry', () => {
    const result = build({
      skeleton: skeletonStage([{ name: 'Workshops', weight: 10 }]),
      ed: edApiStage([
        { id: '7101', title: 'Synthetic weekly workshop', dueAt: '2026-10-30T12:59:00Z' },
        { id: '7102', title: 'Synthetic unclassified lesson', dueAt: '2026-11-06T12:59:00Z' },
      ]),
      classification: classification([
        { id: 'ed:7101', category: 'ungraded', component: 'Workshops', evidence: 'Synthetic Ed lesson list' },
      ]),
    });
    const ungraded = result.document.components.find(component => component.key === `${code}:ungraded`)!;
    expect(ungraded.items.map(item => item.key)).toEqual([
      `${code}:ed:lesson:7101`, `${code}:ed:lesson:7102`,
    ]);
    expect(ungraded.items.map(item => item.weight)).toEqual([
      { value: 0, state: 'derived' }, { value: 0, state: 'derived' },
    ]);
    expect(classificationRetryIds(result)).toEqual([]);

    const saved = save(result);
    for (const lessonId of ['7101', '7102']) {
      expect(saved.store.loadAssessment(assessmentId(term, `${code}:ed:lesson:${lessonId}`)))
        .toMatchObject({ kind: 'ungraded', weight: 0 });
    }
    const work = collectWork(saved.store, term, 'Australia/Melbourne');
    const planned = [...work.items, ...work.deadlines].map(entry => entry.workId);
    expect(planned).not.toContain(assessmentId(term, `${code}:ed:lesson:7101`));
    expect(planned).not.toContain(assessmentId(term, `${code}:ed:lesson:7102`));
  });

  it('keeps only the Canvas item when an Ed lesson name normalizes to the same name', () => {
    const result = build({
      skeleton: skeletonStage([{ name: 'Quizzes', weight: 10 }]),
      groups: groupsStage([{ name: 'Quizzes', weight: 10, items: [{ id: '1', name: 'Synthetic Shared Quiz' }] }]),
      ed: edApiStage([
        { id: '7201', title: 'synthetic shared quiz', dueAt: '2026-10-30T12:59:00Z' },
        { id: '7202', title: 'Synthetic unique quiz', dueAt: '2026-11-06T12:59:00Z' },
      ]),
      classification: classification([
        { id: '1', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic group name' },
        { id: 'ed:7201', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic Ed lesson list' },
        { id: 'ed:7202', category: 'quiz', component: 'Quizzes', evidence: 'Synthetic Ed lesson list' },
      ]),
    });
    expect(result.document.components.flatMap(component => component.items.map(item => item.key)))
      .toEqual([`${code}:canvas:assignment:1`, `${code}:ed:lesson:7202`]);
    const saved = save(result);
    expect(saved.store.loadAssessment(assessmentId(term, `${code}:ed:lesson:7201`))).toBeUndefined();
    expect(saved.store.loadAssessment(assessmentId(term, `${code}:ed:lesson:7202`))).toMatchObject({ kind: 'quiz' });
    expect(saved.store.loadAssessment(assessmentId(term, `${code}:canvas:assignment:1`))).toMatchObject({ kind: 'quiz' });
  });

  it('builds fallback Ed items with slugged stable keys, the page quote and source, and no URL', () => {
    const stages = {
      skeleton: skeletonStage([{ name: 'Workshops', weight: 20 }]),
      ed: edPageStage([
        { title: 'Weekly Workshop', dueAt: '2026-10-30T12:59:00Z' },
        { title: 'Synthetic undated workshop' },
        { title: 'Weekly Workshop', dueAt: '2026-11-06T12:59:00Z' },
      ]),
      classification: classification([
        { id: 'ed:1', category: 'participation', component: 'Workshops', evidence: 'Synthetic Ed page quote' },
        { id: 'ed:3', category: 'participation', component: 'Workshops', evidence: 'Synthetic Ed page quote' },
      ]),
    };
    const first = build(stages);
    const second = build(stages);
    const keys = (result: typeof first) => result.document.components
      .flatMap(component => component.items.map(item => item.key)).filter(itemKey => itemKey.includes(':ed:'));
    expect(keys(first)).toEqual([`${code}:ed:lesson:weekly-workshop`, `${code}:ed:lesson:weekly-workshop-2`]);
    expect(keys(second)).toEqual(keys(first));

    const items = first.document.components.find(component => component.key === `${code}:workshops`)!.items;
    expect(items.map(item => item.key)).toEqual(keys(first));
    expect(items[0]).toMatchObject({
      name: { value: 'Weekly Workshop', via: 'ax', quote: 'Synthetic quote for Weekly Workshop', source: edPage },
      due: { value: '2026-10-30T12:59:00Z', via: 'ax', quote: 'Synthetic quote for Weekly Workshop', source: edPage },
    });
    expect(items[0]).not.toHaveProperty('url');
    expect(items[1]!.due).toMatchObject({ value: '2026-11-06T12:59:00Z', via: 'ax', source: edPage });
  });

  it('reads the hurdle minimum from the phrase that states it, not the first percentage', () => {
    const hurdle = (text: string) => build({ skeleton: skeletonStage([{ name: 'Final exam', weight: 50, hurdle: text }]) })
      .document.components[0]!.hurdleMin;
    expect(hurdle('The exam (60%) is a hurdle; at least 50% is required.'))
      .toMatchObject({ value: 50, state: 'found', via: 'handbook', quote: 'The exam (60%) is a hurdle; at least 50% is required.' });
    expect(hurdle('The exam (60%) is a hurdle; a passing grade of 65% is required.'))
      .toMatchObject({ value: 65, state: 'found' });
    expect(hurdle('The exam (60%) is a hurdle; the minimum is 55%.'))
      .toMatchObject({ value: 55, state: 'found' });
    expect(hurdle('The exam (60%) is a hurdle.')).toEqual({ value: null, state: 'unknown', checkedAt: now });
  });
});
