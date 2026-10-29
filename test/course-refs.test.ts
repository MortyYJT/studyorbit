import { describe, expect, it } from 'vitest';
import { CourseDocumentV2Schema } from '../shared/course-data.js';
import { backfillFacts, buildLegacyIds, buildSources, buildStoredDocument, canonicalRefs, compareIds, generateIds, indexCollected, normaliseText, parseHandbookComponents, slug } from '../scripts/lib/course-refs.mjs';

// Synthetic Handbook text only; no real course content.

describe('normaliseText', () => {
  it('strips tags, decodes entities, unifies dashes and quotes, folds case and whitespace', () => {
    expect(normaliseText('<b>Project</b>&nbsp;&ndash;&#160;30%')).toBe('project &ndash; 30%');
    expect(normaliseText('Mid‑Semester\tTest\n')).toBe('mid-semester test');
    expect(normaliseText('“A” ‘b’ – — − &amp; &lt;x&gt; &quot;q&quot; &#39;s&#39; &#x41;')).toBe('"a" \'b\' - - - & <x> "q" \'s\' a');
  });
});

describe('parseHandbookComponents', () => {
  const names = (text: string) => parseHandbookComponents(text).map(item => [item.name, item.percent]);

  it('reads a row with a timing cell between the name and the percentage', () => {
    expect(parseHandbookComponents('Assessment\nProject report\tWeek 10\t30%\n')).toEqual([
      { name: 'Project report', percent: 30, rowTexts: ['Project report Week 10 30%'] },
    ]);
  });

  it('keeps a multi-line first cell together and names the row by its first line', () => {
    const text = 'Description\tTiming\tPercentage\nMid-semester test\nOnline, 45 minutes\n\tWeek 6\t15%\nExam\tEnd of semester\t85%';
    expect(parseHandbookComponents(text)).toEqual([
      { name: 'Mid-semester test', percent: 15, rowTexts: ['Mid-semester test Online, 45 minutes Week 6 15%'] },
      { name: 'Exam', percent: 85, rowTexts: ['Exam End of semester 85%'] },
    ]);
  });

  it('starts the first row after the header line, not at the top of the page', () => {
    const text = 'Overview text\nmore text\nDescription\tTiming\tPercentage\nEssay\n\tWeek 4\t40%';
    expect(names(text)).toEqual([['Essay', 40]]);
  });

  it('parses a hurdle row without a percentage and the next row separately', () => {
    const text = 'Description\tTiming\tPercentage\nAttend 8 of 10 labs\tThroughout\tN/A\nExam\tExam period\t60.5 %';
    expect(names(text)).toEqual([['Attend 8 of 10 labs', null], ['Exam', 60.5]]);
    expect(names('Hurdle A\tWeekly\tNil\nHurdle B\tWeekly\t-\nHurdle C\tWeekly\t—')).toEqual([['Hurdle A', null], ['Hurdle B', null], ['Hurdle C', null]]);
  });

  it('merges a table repeated per study period and keeps every row text', () => {
    const table = 'Description\tTiming\tPercentage\nProject report\tWeek 10\t30%\nExam\tExam period\t70%';
    expect(parseHandbookComponents(`Semester 1\n${table}\nSemester 2\n${table.replace('Week 10', 'Week 11')}`)).toEqual([
      { name: 'Project report', percent: 30, rowTexts: ['Project report Week 10 30%', 'Project report Week 11 30%'] },
      { name: 'Exam', percent: 70, rowTexts: ['Exam Exam period 70%', 'Exam Exam period 70%'] },
    ]);
  });

  it('suffixes the same name with a different percentage in page order', () => {
    expect(names('Quiz\tWeekly\t10%\nQuiz\tWeek 12\t5%\nquiz \tWeek 13\t2%\nQuiz\tWeekly\t10%')).toEqual([['Quiz', 10], ['Quiz (2)', 5], ['quiz (3)', 2]]);
  });

  it('collapses whitespace in the name, limits it to 200 characters and skips empty names', () => {
    expect(names(`Group   project\t(team)\tWeek 9\t20%\n\tWeek 2\t5%\n${'x'.repeat(250)}\tWeek 3\t1%`)).toEqual([['Group project', 20], ['x'.repeat(200), 1]]);
  });

  it('finds nothing when no line ends with a percentage cell', () => {
    expect(parseHandbookComponents('Assessment. Weekly quizzes (20%), exam (80%).\nNo table here')).toEqual([]);
    expect(parseHandbookComponents('')).toEqual([]);
    expect(parseHandbookComponents('Week 3\t30% of the subject')).toEqual([]);
  });

  it('ignores carriage returns', () => {
    expect(names('Essay\tWeek 4\t40%\r\nExam\tEnd\t60%\r\n')).toEqual([['Essay', 40], ['Exam', 60]]);
  });
});

describe('slug', () => {
  it('uses NFKC, lowercase and one dash per run of other characters', () => {
    expect(slug('Final Examination (3 hours)')).toBe('final-examination-3-hours');
    expect(slug('Ｑｕｉｚ　１ — Part A')).toBe('quiz-1-part-a');
    expect(slug('期末 考试')).toBe('期末-考试');
    expect(slug('Café')).toBe('café');
  });

  it('turns an empty slug into item', () => {
    expect(slug('---')).toBe('item');
    expect(slug('')).toBe('item');
  });
});

describe('generateIds', () => {
  type Ref = { platform: 'canvas' | 'canvas-group' | 'ed' | 'handbook'; id: string };
  const item = (key: string, refs: Ref[], patch: Record<string, unknown> = {}) => ({ key, parentKey: null as string | null, refs, name: `Item ${key}`, ...patch });
  const ids = (items: ReturnType<typeof item>[]) => generateIds(items).ids;

  it('takes the base ID from the highest-priority platform', () => {
    expect(ids([
      item('a', [{ platform: 'ed', id: '77' }, { platform: 'canvas', id: '5551' }]),
      item('b', [{ platform: 'handbook', id: 'Exam' }, { platform: 'ed', id: '78' }]),
      item('c', [{ platform: 'handbook', id: 'Exam' }, { platform: 'canvas-group', id: '300' }]),
      item('d', [{ platform: 'handbook', id: 'Final Examination (3 hours)' }]),
      item('e', [], { name: 'Weekly Quizzes' }),
    ])).toEqual(['canvas:5551', 'ed:78', 'canvas-group:300', 'handbook:final-examination-3-hours', 'group:weekly-quizzes']);
  });

  it('uses the smallest ID on a platform, so the order of references does not matter', () => {
    expect(ids([item('a', [{ platform: 'canvas', id: '12' }, { platform: 'canvas', id: '9' }])])).toEqual(['canvas:9']);
    expect(ids([item('a', [{ platform: 'canvas', id: '9' }, { platform: 'canvas', id: '12' }])])).toEqual(['canvas:9']);
    expect(ids([item('a', [{ platform: 'handbook', id: 'b exam' }, { platform: 'handbook', id: 'a test' }])])).toEqual(['handbook:a-test']);
    expect(ids([item('a', [{ platform: 'ed', id: 'x1' }, { platform: 'ed', id: '20' }])])).toEqual(['ed:20']);
  });

  it('orders all-digit IDs before the others, so the primary reference is the same for any input order', () => {
    const refs = ['10', '9', '1a'].map(id => ({ platform: 'canvas' as const, id }));
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) expect(ids([item('a', order.map(i => refs[i]))])).toEqual(['canvas:9']);
    expect(['b', '10', 'a', '9', '1a'].sort(compareIds)).toEqual(['9', '10', '1a', 'a', 'b']);
  });

  it('suffixes every item that shares a repeatable base ID with its name slug', () => {
    expect(ids([
      item('a', [{ platform: 'handbook', id: 'Examination' }], { name: 'Final exam' }),
      item('b', [{ platform: 'handbook', id: 'Examination' }], { name: 'Final exam (alternative)' }),
      item('c', [{ platform: 'canvas-group', id: '300' }], { name: 'Quizzes' }),
      item('d', [{ platform: 'canvas-group', id: '300' }], { name: 'Quiz hurdle' }),
      item('e', [], { name: 'Labs' }),
      item('f', [], { name: 'labs!' }),
      item('g', [{ platform: 'handbook', id: 'Project' }], { name: 'Project' }),
    ])).toEqual([
      'handbook:examination:final-exam', 'handbook:examination:final-exam-alternative',
      'canvas-group:300:quizzes', 'canvas-group:300:quiz-hurdle', 'group:labs:labs', 'group:labs:labs', 'handbook:project',
    ]);
  });

  it('maps parentKey to the final ID of the parent', () => {
    const result = generateIds([
      item('kids', [], { name: 'Quizzes' }),
      item('q1', [{ platform: 'canvas', id: '7101' }], { parentKey: 'kids' }),
      item('q2', [{ platform: 'canvas', id: '7102' }], { parentKey: 'ghost' }),
    ]);
    expect(result).toEqual({ ids: ['group:quizzes', 'canvas:7101', 'canvas:7102'], parentIds: [null, 'group:quizzes', null] });
  });
});

describe('fact back-fill', () => {
  const url = (id: number) => `https://canvas.example.edu/courses/900001/assignments/${id}`;
  const assignment = (id: number, patch: Record<string, unknown> = {}) => ({
    id, name: `Task ${id}`, group_id: 300, points_possible: 20, due_at: '2026-08-20T13:59:00Z', unlock_at: null, html_url: url(id), submission: null, ...patch,
  });
  const lesson = (id: string, patch: Record<string, unknown> = {}) => ({ id, title: `Lesson ${id}`, module: 'Labs', due: '2026-08-21T13:59:00Z', status: 'completed', url: `https://edstem.example.org/courses/42/lessons/${id}`, ...patch });
  const index = indexCollected({
    canvas: {
      groups: [{ id: 300, name: 'Quizzes', group_weight: 20, rules: {} }],
      assignments: [
        assignment(1, { submission: { score: 17, workflow_state: 'graded', submitted_at: '2026-08-19T00:00:00Z' } }),
        assignment(2, { points_possible: 100, due_at: null, submission: { score: null, workflow_state: 'unsubmitted', submitted_at: null } }),
        assignment(3, { submission: { score: null, workflow_state: 'pending_review', submitted_at: '2026-08-19T00:00:00Z' } }),
        assignment(4, { submission: { score: null, workflow_state: 'unsubmitted', submitted_at: null } }),
        assignment(5, { points_possible: 10, submission: { score: 12, workflow_state: 'graded', submitted_at: null } }),
        assignment(6, { submission: { score: null, workflow_state: 'unsubmitted', submitted_at: '2026-08-19T00:00:00Z' } }),
        assignment(7, { submission: { score: null, workflow_state: 'submitted', submitted_at: '2026-08-19T00:00:00Z' } }),
        assignment(8, { points_possible: null, submission: { score: null, workflow_state: 'graded', submitted_at: null } }),
      ],
    },
    ed: {
      status: 'ok',
      lessons: [lesson('77'), lesson('78'), lesson('79', { due: null }), lesson('80'), lesson('81')],
      scores: [
        { lessonId: '77', status: 'graded', score: 8, maxScore: 10, submittedAt: null },
        { lessonId: '78', status: 'not_available', score: null, maxScore: null, submittedAt: '2026-08-19T00:00:00Z' },
        { lessonId: '79', status: 'no_final_submission', score: null, maxScore: null, submittedAt: null },
        { lessonId: '80', status: 'not_available', score: null, maxScore: null, submittedAt: null },
      ],
    },
    handbook: { status: 'available', url: 'https://handbook.example.edu/2026/subjects/synt10001/assessment', text: 'Final exam\tExam period\t60%' },
  });
  const facts = (...refs: [string, string][]) => backfillFacts(index, refs.map(([platform, id]) => ({ platform, id }) as Ref));
  type Ref = Parameters<typeof backfillFacts>[1][number];

  it('takes a graded Canvas pair with its due date', () => {
    expect(facts(['canvas', '1'])).toEqual({ due: '2026-08-20T13:59:00Z', score: 17, maxScore: 20, status: 'graded' });
  });

  it('does not mix an Ed score with the Canvas maximum', () => {
    expect(facts(['canvas', '2'], ['ed', '77'])).toEqual({ due: '2026-08-21T13:59:00Z', score: 8, maxScore: 10, status: 'graded' });
  });

  it('keeps the Canvas maximum when nothing is graded', () => {
    expect(facts(['canvas', '2'], ['ed', '79'])).toEqual({ due: null, score: null, maxScore: 100, status: 'not_started' });
  });

  it('keeps a score above the maximum and drops the maximum', () => {
    expect(facts(['canvas', '5'])).toMatchObject({ score: 12, maxScore: null, status: 'graded' });
  });

  it('maps Canvas submission states', () => {
    expect(facts(['canvas', '3'])).toMatchObject({ status: 'submitted', score: null, maxScore: 20 });
    expect(facts(['canvas', '7']).status).toBe('submitted');
    expect(facts(['canvas', '4']).status).toBe('not_started');
    expect(facts(['canvas', '6']).status).toBe('unknown');
    expect(facts(['canvas', '8'])).toMatchObject({ status: 'graded', score: null, maxScore: null });
    expect(facts(['canvas', '9999']).status).toBe('unknown');
  });

  it('maps Ed score records', () => {
    expect(facts(['ed', '77'])).toEqual({ due: '2026-08-21T13:59:00Z', score: 8, maxScore: 10, status: 'graded' });
    expect(facts(['ed', '78']).status).toBe('submitted');
    expect(facts(['ed', '79']).status).toBe('not_started');
    expect(facts(['ed', '80']).status).toBe('unknown');
    expect(facts(['ed', '81'])).toEqual({ due: '2026-08-21T13:59:00Z', score: null, maxScore: null, status: 'unknown' });
  });

  it('takes the most advanced status across sources', () => {
    expect(facts(['canvas', '4'], ['ed', '77']).status).toBe('graded');
    expect(facts(['canvas', '3'], ['ed', '79']).status).toBe('submitted');
    expect(facts(['canvas', '6'], ['ed', '79']).status).toBe('not_started');
  });

  it('uses the primary reference on each platform', () => {
    expect(facts(['canvas', '4'], ['canvas', '1'])).toMatchObject({ score: 17, status: 'graded' });
  });

  it('leaves group, Handbook and model-only items without facts', () => {
    const empty = { due: null, score: null, maxScore: null, status: 'unknown' };
    expect(facts(['canvas-group', '300'])).toEqual(empty);
    expect(facts(['handbook', 'Final exam'])).toEqual(empty);
    expect(facts()).toEqual(empty);
  });

  it('builds sources from references', () => {
    expect(buildSources(index, [
      { platform: 'canvas', id: '1' }, { platform: 'ed', id: '77' }, { platform: 'handbook', id: 'Final exam' }, { platform: 'canvas-group', id: '300' },
    ])).toEqual([
      { platform: 'canvas', url: url(1), evidence: null },
      { platform: 'ed', url: 'https://edstem.example.org/courses/42/lessons/77', evidence: null },
      { platform: 'handbook', url: 'https://handbook.example.edu/2026/subjects/synt10001/assessment', evidence: null },
      { platform: 'canvas', url: null, evidence: null },
    ]);
  });

  it('drops a URL that is not HTTP(S)', () => {
    const odd = indexCollected({ canvas: { assignments: [assignment(1, { html_url: 'javascript:alert(1)' })], groups: [] } });
    expect(buildSources(odd, [{ platform: 'canvas', id: '1' }])).toEqual([{ platform: 'canvas', url: null, evidence: null }]);
  });

  it('stores the canonical Handbook name in refs', () => {
    expect(canonicalRefs(index, [{ platform: 'handbook', id: 'FINAL  exam' }, { platform: 'handbook', id: 'final exam' }, { platform: 'canvas', id: '1' }]))
      .toEqual([{ platform: 'handbook', id: 'Final exam' }, { platform: 'canvas', id: '1' }]);
  });
});

describe('buildLegacyIds', () => {
  type Ref = { platform: 'canvas' | 'canvas-group' | 'ed' | 'handbook'; id: string };
  const canvasUrl = (id: string) => `https://canvas.example.edu/courses/900001/assignments/${id}`;
  const edUrl = (id: string) => `https://edstem.example.org/courses/42/lessons/${id}`;
  const v1 = (id: string, name: string, urls: [string, string][] = []) => ({ id, name, sources: urls.map(([platform, url]) => ({ platform, url, evidence: null })) });
  const v2 = (id: string, name: string, refs: Ref[] = []) => ({ id, name, refs });
  const previousV1 = (...assessments: ReturnType<typeof v1>[]) => ({ version: 1 as const, assessments });
  const previousV2 = (assessments: ReturnType<typeof v2>[], legacyIds: Record<string, string> = {}) => ({ version: 2 as const, assessments, legacyIds });
  const current = (...assessments: ReturnType<typeof v2>[]) => ({ assessments });
  const canvas = (id: string): Ref => ({ platform: 'canvas', id });
  const ed = (id: string): Ref => ({ platform: 'ed', id });

  it('is empty without an earlier document', () => {
    expect(buildLegacyIds(null, current(v2('canvas:1', 'A', [canvas('1')])))).toEqual({});
  });

  it('maps v1 items by Canvas and Ed source URLs', () => {
    expect(buildLegacyIds(previousV1(
      v1('a1', 'Assignment 1', [['canvas', canvasUrl('5551')]]),
      v1('lab', 'Lab', [['ed', edUrl('77')]]),
    ), current(v2('canvas:5551', 'Assignment One', [canvas('5551')]), v2('ed:77', 'Lab 1', [ed('77')])))).toEqual({ a1: 'canvas:5551', lab: 'ed:77' });
  });

  it('maps platform-shaped v1 IDs, trying bare digits as Canvas before Ed', () => {
    expect(buildLegacyIds(previousV1(v1('77', 'Lab')), current(v2('ed:77', 'Lab one', [ed('77')])))).toEqual({ 77: 'ed:77' });
    expect(buildLegacyIds(previousV1(v1('77', 'Lab')), current(v2('canvas:77', 'X', [canvas('77')]), v2('ed:77', 'Y', [ed('77')])))).toEqual({ 77: 'canvas:77' });
    expect(buildLegacyIds(
      previousV1(v1('canvas-1', 'A'), v1('canvas:2', 'B'), v1('ed-3', 'C'), v1('ed:4', 'D')),
      current(v2('canvas:1', 'P', [canvas('1')]), v2('canvas:2', 'Q', [canvas('2')]), v2('ed:3', 'R', [ed('3')]), v2('ed:4', 'S', [ed('4')])),
    )).toEqual({ 'canvas-1': 'canvas:1', 'ed-3': 'ed:3' });
  });

  it('falls back to a name slug that is unique on both sides', () => {
    expect(buildLegacyIds(previousV1(v1('exam', 'Final Exam'), v1('hurdle', 'Hurdle')),
      current(v2('handbook:final-exam', 'Final exam!', [{ platform: 'handbook', id: 'Final exam' }]), v2('group:hurdle', 'Hurdle'), v2('group:hurdle-2', 'hurdle'))))
      .toEqual({ exam: 'handbook:final-exam' });
  });

  it('pairs equal IDs first and leaves them out of the later steps', () => {
    expect(buildLegacyIds(previousV2([v2('handbook:exam', 'Exam', [{ platform: 'handbook', id: 'Exam' }]), v2('group:exam', 'Exam')]),
      current(v2('handbook:exam', 'Exam', [{ platform: 'handbook', id: 'Exam' }]), v2('group:exam-1', 'Exam')))).toEqual({ 'group:exam': 'group:exam-1' });
  });

  it('drops ambiguous pairs', () => {
    expect(buildLegacyIds(previousV1(v1('a', 'A', [['canvas', canvasUrl('5551')]]), v1('b', 'B', [['canvas', canvasUrl('5551')]])),
      current(v2('canvas:5551', 'A', [canvas('5551')])))).toEqual({});
    expect(buildLegacyIds(previousV1(v1('q', 'Quizzes', [['canvas', canvasUrl('1')], ['canvas', canvasUrl('2')]])),
      current(v2('canvas:1', 'Quiz 1', [canvas('1')]), v2('canvas:2', 'Quiz 2', [canvas('2')])))).toEqual({});
  });

  it('leaves a current item unmapped when several earlier items match it, even if one of them also matches another item', () => {
    expect(buildLegacyIds(previousV1(v1('a', 'A', [['canvas', canvasUrl('1')], ['ed', edUrl('2')]]), v1('b', 'B', [['canvas', canvasUrl('1')]])),
      current(v2('canvas:1', 'P', [canvas('1')]), v2('ed:2', 'Q', [ed('2')])))).toEqual({});
  });

  it('does not let a name match take an item already matched by platform identity', () => {
    expect(buildLegacyIds(previousV1(v1('a1', 'Report', [['canvas', canvasUrl('5551')]]), v1('report', 'Quiz')),
      current(v2('canvas:5551', 'Quiz', [canvas('5551')])))).toEqual({ a1: 'canvas:5551' });
  });

  it('uses v2 refs of the earlier document', () => {
    expect(buildLegacyIds(previousV2([v2('canvas-group:300:quizzes', 'Quizzes', [{ platform: 'canvas-group', id: '300' }]), v2('canvas:9', 'Quiz', [canvas('9'), canvas('12')])]),
      current(v2('canvas-group:300', 'Quizzes', [{ platform: 'canvas-group', id: '300' }]), v2('canvas:12', 'Quiz', [canvas('12')]))))
      .toEqual({ 'canvas-group:300:quizzes': 'canvas-group:300', 'canvas:9': 'canvas:12' });
  });

  it('carries the earlier map forward, composes it and drops entries without a target', () => {
    const previous = previousV2([v2('canvas:5551', 'A', [canvas('5551')]), v2('handbook:exam', 'Exam', [{ platform: 'handbook', id: 'Exam' }])],
      { a1: 'canvas:5551', x: 'handbook:exam', gone: 'canvas:9', 'handbook:exam:final': 'handbook:exam' });
    expect(buildLegacyIds(previous, current(v2('canvas:5551', 'A', [canvas('5551')]), v2('handbook:exam:final', 'Exam', [{ platform: 'handbook', id: 'Exam' }]))))
      .toEqual({ a1: 'canvas:5551', x: 'handbook:exam:final', 'handbook:exam': 'handbook:exam:final' });
  });
});

describe('buildStoredDocument', () => {
  const course = { id: '900001', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' };
  const collected = {
    canvas: {
      groups: [{ id: 300, name: 'Quizzes', group_weight: 20, rules: {} }],
      assignments: [
        { id: 5551, name: 'Quiz 1', group_id: 300, points_possible: 10, due_at: '2026-08-07T13:59:00Z', unlock_at: null,
          html_url: 'https://canvas.example.edu/courses/900001/assignments/5551', submission: { score: 8, workflow_state: 'graded', submitted_at: null } },
      ],
    },
    ed: { status: 'ok', lessons: [{ id: '77', title: 'Lab', module: 'Labs', due: null, status: 'completed', url: 'https://edstem.example.org/courses/42/lessons/77' }], scores: [] },
    handbook: { status: 'available', url: 'https://handbook.example.edu/2026/subjects/synt10001/assessment', text: 'Quizzes\tWeekly\t20%\nFinal exam\tExam period\t80%' },
  };
  const modelItem = (key: string, patch: Record<string, unknown> = {}) => ({
    key, parentKey: null, refs: [], name: key, kind: 'quiz', nature: 'regular', scoring: 'none',
    weight: null, weightQuote: null, rule: null, ruleQuote: null, ...patch,
  });
  const model = {
    version: 2 as const, course, materials: [{ name: 'Slides', url: 'https://canvas.example.edu/files/1', platform: 'canvas' as const }],
    assessments: [
      modelItem('quizzes', { name: 'Quizzes', refs: [{ platform: 'canvas-group', id: '300' }, { platform: 'handbook', id: 'quizzes' }, { platform: 'canvas-group', id: '300' }],
        scoring: 'weighted', weight: 20, weightQuote: 'Quizzes Weekly 20%' }),
      modelItem('q1', { name: 'Quiz 1', parentKey: 'quizzes', refs: [{ platform: 'canvas', id: '5551' }], weight: 20, rule: null, ruleQuote: 'stray quote' }),
      modelItem('lab', { name: 'Lab', kind: 'participation', nature: 'ungraded', refs: [{ platform: 'ed', id: '77' }], rule: 'Attend', ruleQuote: 'Attend 8 labs' }),
      modelItem('exam', { name: 'Final exam', kind: 'test', refs: [{ platform: 'handbook', id: 'FINAL EXAM' }], weight: 80 }),
    ],
  } as Parameters<typeof buildStoredDocument>[0];

  it('builds a valid stored v2 document with code-filled IDs and facts', () => {
    const stored = buildStoredDocument(model, collected, null);
    expect(CourseDocumentV2Schema.safeParse(stored).success).toBe(true);
    expect(stored).toMatchObject({ version: 2, course, materials: model.materials, legacyIds: {} });
    expect(stored.assessments).toEqual([
      { id: 'canvas-group:300', name: 'Quizzes', kind: 'quiz', nature: 'regular', parentId: null, weight: 20, score: null, maxScore: null, due: null, status: 'unknown',
        scoring: 'weighted', rule: null, refs: [{ platform: 'canvas-group', id: '300' }, { platform: 'handbook', id: 'Quizzes' }],
        sources: [{ platform: 'canvas', url: null, evidence: null }, { platform: 'handbook', url: collected.handbook.url, evidence: null }],
        weightQuote: 'Quizzes Weekly 20%', ruleQuote: null, unsourced: [] },
      { id: 'canvas:5551', name: 'Quiz 1', kind: 'quiz', nature: 'regular', parentId: 'canvas-group:300', weight: 20, score: 8, maxScore: 10, due: '2026-08-07T13:59:00Z',
        status: 'graded', scoring: 'none', rule: null, refs: [{ platform: 'canvas', id: '5551' }],
        sources: [{ platform: 'canvas', url: 'https://canvas.example.edu/courses/900001/assignments/5551', evidence: null }],
        weightQuote: null, ruleQuote: null, unsourced: [] },
      { id: 'ed:77', name: 'Lab', kind: 'participation', nature: 'ungraded', parentId: null, weight: null, score: null, maxScore: null, due: null, status: 'unknown',
        scoring: 'none', rule: 'Attend', refs: [{ platform: 'ed', id: '77' }],
        sources: [{ platform: 'ed', url: 'https://edstem.example.org/courses/42/lessons/77', evidence: null }],
        weightQuote: null, ruleQuote: 'Attend 8 labs', unsourced: [] },
      { id: 'handbook:final-exam', name: 'Final exam', kind: 'test', nature: 'regular', parentId: null, weight: 80, score: null, maxScore: null, due: null, status: 'unknown',
        scoring: 'none', rule: null, refs: [{ platform: 'handbook', id: 'Final exam' }],
        sources: [{ platform: 'handbook', url: collected.handbook.url, evidence: null }],
        weightQuote: null, ruleQuote: null, unsourced: [] },
    ]);
  });

  it('records the legacy ID map from the earlier document', () => {
    const previous = { version: 1 as const, course, materials: [], assessments: [
      { id: 'q1', name: 'Quiz 1', kind: 'quiz' as const, nature: 'regular' as const, parentId: null, weight: 20, score: 8, maxScore: 10, due: null, status: 'graded' as const,
        scoring: 'none' as const, rule: null, sources: [{ platform: 'canvas' as const, url: 'https://canvas.example.edu/courses/900001/assignments/5551', evidence: null }] },
    ] };
    expect(buildStoredDocument(model, collected, previous).legacyIds).toEqual({ q1: 'canvas:5551' });
  });

  it('refuses output whose references were not collected', () => {
    const invented = { ...model, assessments: [modelItem('x', { refs: [{ platform: 'canvas', id: '999' }] })] } as typeof model;
    expect(() => buildStoredDocument(invented, collected, null)).toThrow(/canvas 999/);
  });
});
