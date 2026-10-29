import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CourseDocumentV2Schema, type CourseDocumentV2 } from '../shared/course-data.js';
import { normaliseText, quoteCorpus, quoteFound, verifyQuotes } from '../scripts/lib/course-quotes.mjs';
import { settleCourse, validateAnalysis } from '../scripts/lib/course-validation.mjs';

// Synthetic collected data only; no real course content.
const handbook = {
  status: 'available', url: 'https://handbook.example.edu/2026/subjects/synt10001/assessment',
  text: [
    'Assessment overview',
    'Description\tTiming\tPercentage',
    'Project report\tWeek 10\t30%',
    'Mid-semester test',
    'Online, 45 minutes',
    '\tWeek 6\t15%',
    'Weekly quizzes\tWeekly\t20%',
    'Final exam\tExam period\t35%',
    'Hurdle requirement: at least 50% on the final exam.',
  ].join('\n'),
};
const canvas = {
  groups: [
    { id: 300, name: 'Quizzes (20 percent)', group_weight: 20, rules: { drop_lowest: 2, never_drop: [9002] } },
    { id: 301, name: 'Labs', group_weight: 33.333, rules: {} },
    { id: 302, name: 'Unweighted', group_weight: null, rules: {} },
  ],
  assignments: [
    { id: 9001, name: 'Quiz 5 worth 5%', group_id: 300, points_possible: 10, due_at: null, html_url: 'https://canvas.example.edu/courses/1/assignments/9001', submission: null },
    { id: 9002, name: 'Quiz 1', group_id: 300, points_possible: 10, due_at: null, html_url: 'https://canvas.example.edu/courses/1/assignments/9002', submission: null },
  ],
};
const ed = {
  lessons: [{ id: 77, title: 'Lab report 12.5% guide', module: 'Labs', due: null, status: 'open', url: 'https://edstem.example.org/courses/2/lessons/77' }],
  scores: [],
  context: [
    { lessonId: 77, slideId: 1, text: '<p>Project – 30%</p>', url: 'https://edstem.example.org/courses/2/lessons/77/slides/1' },
    { lessonId: 77, slideId: 2, text: 'Quizzes worth 25% in total. Quiz 5 due in week 5.', url: 'https://edstem.example.org/courses/2/lessons/77/slides/2' },
    { lessonId: 77, slideId: 3, text: 'Participation is worth 10 per cent of the mark; labs are 10.5% of the mark.', url: 'https://edstem.example.org/courses/2/lessons/77/slides/3' },
  ],
};
const collected = { canvas, ed, handbook };

type Item = CourseDocumentV2['assessments'][number];
const item = (patch: Partial<Item>): Item => ({
  id: 'group:item', name: 'Item', kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null,
  due: null, status: 'unknown', scoring: 'none', rule: null, sources: [], refs: [], weightQuote: null, ruleQuote: null, unsourced: [], ...patch,
});
const doc = (assessments: Item[]): CourseDocumentV2 => ({
  version: 2, course: { id: '900001', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' }, assessments, materials: [], legacyIds: {},
});
const verifyOne = (patch: Partial<Item>) => {
  const { document, cleared } = verifyQuotes(doc([item(patch)]), collected);
  return { ...document.assessments[0], cleared };
};

describe('quote normalisation', () => {
  it('strips tags, decodes entities, applies NFKC, folds case, quotes, dashes and all whitespace', () => {
    expect(normaliseText('<p>Project&nbsp;&ndash;&#160;<b>30%</b></p>')).toBe('project &ndash; 30%');
    expect(normaliseText('&amp; &lt; &gt; &quot;x&quot; &#39;y&#39; &#x41;')).toBe('& < > "x" \'y\' a');
    expect(normaliseText('ＷＥＥＫ　１０\t３０％')).toBe('week 10 30%');
    expect(normaliseText('“Quoted” ‘text’')).toBe('"quoted" \'text\'');
    expect(normaliseText('a‐b‑c‒d–e—f−g')).toBe('a-b-c-d-e-f-g');
    expect(normaliseText('  Project\treport\n\n Week 10  ')).toBe('project report week 10');
  });
});

describe('quote corpus', () => {
  const units = quoteCorpus(collected).map(unit => unit.text);

  it('has one unit per Handbook row and per other Handbook line', () => {
    expect(units).toContain('project report week 10 30%');
    expect(units).toContain('mid-semester test online, 45 minutes week 6 15%');
    expect(units).toContain('assessment overview');
    expect(units).toContain('hurdle requirement: at least 50% on the final exam.');
    // Lines inside a row are not separate units, so a row fragment cannot lose its component name.
    expect(units).not.toContain('week 6 15%');
    expect(units).not.toContain('online, 45 minutes');
  });

  it('names Handbook row units by their component', () => {
    expect(quoteCorpus(collected).find(unit => unit.text === 'project report week 10 30%')?.name).toBe('project report');
    expect(quoteCorpus(collected).find(unit => unit.text === 'assessment overview')?.name).toBeNull();
  });

  it('has Ed context texts, Canvas group names and rendered group rules', () => {
    expect(units).toContain('project - 30%');
    expect(units).toContain('quizzes (20 percent)');
    expect(units).toContain('labs');
    expect(units).toContain('drop lowest 2; never drop quiz 1');
  });

  it('excludes Canvas assignment names and Ed lesson titles', () => {
    expect(units.some(unit => unit.includes('quiz 5 worth 5%'))).toBe(false);
    expect(units.some(unit => unit.includes('lab report 12.5% guide'))).toBe(false);
  });

  it('never matches a quote across two units', () => {
    const corpus = quoteCorpus(collected);
    expect(quoteFound(corpus, 'Final exam Exam period 35%')).toHaveLength(1);
    expect(quoteFound(corpus, '35% Hurdle requirement')).toHaveLength(0);
  });

  it('has no units for collections that were not collected', () => {
    expect(quoteCorpus({ canvas: { status: 'unavailable' }, ed: { status: 'not_found' }, handbook: { status: 'unavailable' } })).toEqual([]);
  });
});

describe('weight verification', () => {
  it('keeps a weight quoted from a Handbook row with its name', () => {
    expect(verifyOne({ name: 'Project', weight: 30, weightQuote: 'Project report Week 10 30%' }))
      .toMatchObject({ weight: 30, weightQuote: 'Project report Week 10 30%', unsourced: [], cleared: 0 });
  });

  it('keeps a quote from a multi-line Handbook row', () => {
    expect(verifyOne({ name: 'Test', weight: 15, weightQuote: 'Mid-semester test Online, 45 minutes Week 6 15%' })).toMatchObject({ weight: 15, unsourced: [] });
  });

  it('accepts dash and spacing differences in an Ed context text', () => {
    expect(verifyOne({ weight: 30, weightQuote: 'project -  30%' })).toMatchObject({ weight: 30, weightQuote: 'project -  30%', unsourced: [] });
  });

  it('accepts "per cent" and "percent" after the number', () => {
    expect(verifyOne({ weight: 10, weightQuote: 'Participation is worth 10 per cent' })).toMatchObject({ weight: 10, unsourced: [] });
    expect(verifyOne({ weight: 20, weightQuote: 'Quizzes (20 percent)' })).toMatchObject({ weight: 20, unsourced: [] });
  });

  it('keeps a weight equal to the cited Canvas group weight to two decimals, without a quote', () => {
    expect(verifyOne({ weight: 33.33, refs: [{ platform: 'canvas-group', id: '301' }] })).toMatchObject({ weight: 33.33, weightQuote: null, unsourced: [] });
    expect(verifyOne({ weight: 33.3, refs: [{ platform: 'canvas-group', id: '301' }] })).toMatchObject({ weight: null, unsourced: ['weight'] });
  });

  it('keeps a weight equal to the cited Handbook component percentage and drops a failing quote', () => {
    expect(verifyOne({ weight: 30, refs: [{ platform: 'handbook', id: 'Project report' }] })).toMatchObject({ weight: 30, weightQuote: null, unsourced: [] });
    expect(verifyOne({ weight: 30, weightQuote: 'the report is thirty percent', refs: [{ platform: 'handbook', id: 'Project report' }] }))
      .toMatchObject({ weight: 30, weightQuote: null, unsourced: [] });
  });

  it('does not treat a group without a weight as 0%', () => {
    expect(verifyOne({ weight: 0, refs: [{ platform: 'canvas-group', id: '302' }] })).toMatchObject({ weight: null, unsourced: ['weight'] });
  });

  it('does not accept a cited component or group with another percentage', () => {
    expect(verifyOne({ weight: 25, refs: [{ platform: 'handbook', id: 'Project report' }, { platform: 'canvas-group', id: '300' }] }))
      .toMatchObject({ weight: null, unsourced: ['weight'] });
  });

  it('rejects a fragment of another component\'s Handbook row', () => {
    expect(verifyOne({ name: 'Lab report', weight: 15, weightQuote: 'Week 6 15%' })).toMatchObject({ weight: null, weightQuote: null, unsourced: ['weight'], cleared: 1 });
  });

  it('rejects a number without a percent sign', () => {
    expect(verifyOne({ weight: 5, weightQuote: 'Quiz 5 due in week 5' })).toMatchObject({ weight: null, unsourced: ['weight'] });
  });

  it('rejects a number inside a larger number', () => {
    expect(verifyOne({ weight: 5, weightQuote: 'Quizzes worth 25% in total' })).toMatchObject({ weight: null, unsourced: ['weight'] });
    expect(verifyOne({ weight: 5, weightQuote: 'labs are 10.5% of the mark' })).toMatchObject({ weight: null, unsourced: ['weight'] });
    expect(verifyOne({ weight: 10.5, weightQuote: 'labs are 10.5% of the mark' })).toMatchObject({ weight: 10.5, unsourced: [] });
  });

  it('rejects a quote found only in an assignment name or a lesson title', () => {
    expect(verifyOne({ weight: 5, weightQuote: 'Quiz 5 worth 5%' })).toMatchObject({ weight: null, unsourced: ['weight'] });
    expect(verifyOne({ weight: 12.5, weightQuote: 'Lab report 12.5% guide' })).toMatchObject({ weight: null, unsourced: ['weight'] });
  });

  it('rejects a quote that is too short or too long', () => {
    expect(verifyOne({ weight: 30, weightQuote: '30%' })).toMatchObject({ weight: null, unsourced: ['weight'] });
    expect(verifyOne({ weight: 30, weightQuote: `${'x'.repeat(500)} 30%` })).toMatchObject({ weight: null, unsourced: ['weight'] });
  });

  it('flags a weight with no quote and no structured source', () => {
    expect(verifyOne({ weight: 40 })).toMatchObject({ weight: null, weightQuote: null, unsourced: ['weight'] });
  });

  it('drops a quote given with a null weight and keeps a zero weight only with a source', () => {
    expect(verifyOne({ weight: null, weightQuote: 'Project report Week 10 30%' })).toMatchObject({ weight: null, weightQuote: null, unsourced: [], cleared: 0 });
    expect(verifyOne({ weight: 0 })).toMatchObject({ weight: null, unsourced: ['weight'] });
  });
});

describe('rule verification', () => {
  it('keeps a rule quoted from a Canvas drop rule', () => {
    expect(verifyOne({ rule: 'Lowest two quizzes dropped', ruleQuote: 'drop lowest 2', refs: [{ platform: 'canvas-group', id: '300' }] }))
      .toMatchObject({ rule: 'Lowest two quizzes dropped', ruleQuote: 'drop lowest 2', unsourced: [] });
  });

  it('keeps a rule quoted from another Handbook line', () => {
    expect(verifyOne({ rule: 'Hurdle: 50% on the exam', ruleQuote: 'at least 50% on the final exam' })).toMatchObject({ rule: 'Hurdle: 50% on the exam', unsourced: [] });
  });

  it('clears a paraphrased or short rule quote', () => {
    expect(verifyOne({ rule: 'Pass the exam', ruleQuote: 'You must pass the exam to pass' })).toMatchObject({ rule: null, ruleQuote: null, unsourced: ['rule'], cleared: 1 });
    expect(verifyOne({ rule: 'Drops', ruleQuote: 'drop' })).toMatchObject({ rule: null, unsourced: ['rule'] });
    expect(verifyOne({ rule: 'No quote given' })).toMatchObject({ rule: null, unsourced: ['rule'] });
  });

  it('drops a quote given with a null rule', () => {
    expect(verifyOne({ rule: null, ruleQuote: 'drop lowest 2' })).toMatchObject({ rule: null, ruleQuote: null, unsourced: [] });
  });
});

describe('clearing', () => {
  it('lists both fields, counts them and keeps the document valid', () => {
    const { document, cleared } = verifyQuotes(doc([item({ weight: 40, rule: 'Made up', ruleQuote: 'not in the data at all' })]), collected);
    expect(cleared).toBe(2);
    expect(document.assessments[0]).toMatchObject({ weight: null, weightQuote: null, rule: null, ruleQuote: null, unsourced: ['weight', 'rule'] });
    expect(CourseDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it('downgrades a weighted parent whose scoring child loses its weight, and leaves the others', () => {
    const input = doc([
      item({ id: 'group:quizzes', name: 'Quizzes', scoring: 'weighted', weight: 20, refs: [{ platform: 'canvas-group', id: '300' }] }),
      item({ id: 'canvas:9001', name: 'Quiz A', parentId: 'group:quizzes', weight: 10, weightQuote: 'no such text 10%' }),
      item({ id: 'canvas:9002', name: 'Quiz B', parentId: 'group:quizzes', weight: 10, weightQuote: 'Participation is worth 10 per cent' }),
      item({ id: 'group:project', name: 'Project', scoring: 'weighted', weight: 30, refs: [{ platform: 'handbook', id: 'Project report' }] }),
      item({ id: 'group:project-a', name: 'Part A', parentId: 'group:project', weight: 30, weightQuote: 'Project report Week 10 30%' }),
      item({ id: 'group:project-b', name: 'Notes', parentId: 'group:project', nature: 'ungraded', weight: 5 }),
    ]);
    const { document, cleared } = verifyQuotes(input, collected);
    const byId = new Map(document.assessments.map(entry => [entry.id, entry]));
    expect(cleared).toBe(2);
    expect(byId.get('group:quizzes')).toMatchObject({ scoring: 'none', weight: 20 });
    expect(byId.get('canvas:9001')).toMatchObject({ weight: null, unsourced: ['weight'] });
    expect(byId.get('canvas:9002')).toMatchObject({ weight: 10, unsourced: [] });
    // Only regular children count as scoring children.
    expect(byId.get('group:project')).toMatchObject({ scoring: 'weighted' });
    expect(input.assessments[1].weight).toBe(10);
  });

  it('notes cleared fields in the reason and keeps the status', async () => {
    const fixture = join(import.meta.dirname, 'fixtures', 'synthetic-course');
    const read = async (name: string) => JSON.parse(await readFile(join(fixture, name), 'utf8'));
    const [listed, canvasData, edData, handbookData, output] = await Promise.all(['course.json', 'canvas.json', 'ed.json', 'handbook.json', 'outputs/2.json'].map(read));
    const course = { ...listed, subjectCode: 'SYNT10001' };
    for (const entry of output.document.assessments) {
      if (entry.key === 'q1') entry.weightQuote = 'Quiz one is worth 10%';
      if (entry.key === 'exam') entry.ruleQuote = 'You must pass the exam';
    }
    const raw = JSON.stringify(output);
    const validation = validateAnalysis(raw, { course, canvas: canvasData, ed: edData, handbook: handbookData });
    expect(validation.valid).toBe(true);
    const settled = settleCourse({ result: { exitCode: 0, lastMessage: raw, usage: null }, validation, collection: {},
      data: { canvas: canvasData, ed: edData, handbook: handbookData }, previous: null });
    expect(settled.status).toBe('completed');
    expect(settled.reason).toContain('2 项权重或规则无出处');
    const byId = new Map(settled.document!.assessments.map(entry => [entry.id, entry]));
    expect(byId.get('canvas:7101')).toMatchObject({ weight: null, unsourced: ['weight'] });
    expect(byId.get('canvas-group:501')).toMatchObject({ scoring: 'none' });
    expect(byId.get('canvas:7201')).toMatchObject({ rule: null, unsourced: ['rule'], weight: 50 });
  });

  it('leaves the reason alone when nothing was cleared', async () => {
    const fixture = join(import.meta.dirname, 'fixtures', 'synthetic-course');
    const read = async (name: string) => JSON.parse(await readFile(join(fixture, name), 'utf8'));
    const [listed, canvasData, edData, handbookData, output] = await Promise.all(['course.json', 'canvas.json', 'ed.json', 'handbook.json', 'outputs/2.json'].map(read));
    const raw = JSON.stringify(output);
    const course = { ...listed, subjectCode: 'SYNT10001' };
    const validation = validateAnalysis(raw, { course, canvas: canvasData, ed: edData, handbook: handbookData });
    const settled = settleCourse({ result: { exitCode: 0, lastMessage: raw, usage: null }, validation, collection: {},
      data: { canvas: canvasData, ed: edData, handbook: handbookData }, previous: null });
    expect(settled).toMatchObject({ status: 'completed', reason: '' });
  });
});
