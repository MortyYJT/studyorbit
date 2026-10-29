import { describe, expect, it } from 'vitest';
import { analyseWithRepair, settleCourse, validateAnalysis } from '../scripts/lib/course-validation.mjs';

// Synthetic course and collected data only; no real course content.
const course = { id: '900001', subjectCode: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' };
const canvas = {
  groups: [{ id: 300, name: 'Quizzes', group_weight: 20, rules: {} }],
  assignments: [
    { id: 5551, name: 'Quiz 1', group_id: 300, points_possible: 10, due_at: null, html_url: 'https://canvas.example.edu/courses/900001/assignments/5551', submission: null },
    { id: 5552, name: 'Quiz 2', group_id: 300, points_possible: 10, due_at: null, html_url: 'https://canvas.example.edu/courses/900001/assignments/5552', submission: null },
  ],
};
const ed = { status: 'ok', lessons: [{ id: '77', title: 'Lab 1', due: null, url: 'https://edstem.example.org/courses/42/lessons/77' }], scores: [], context: [] };
const handbook = {
  status: 'available', url: 'https://handbook.example.edu/2026/subjects/synt10001/assessment',
  text: 'Description\tTiming\tPercentage\nMid‑Semester Test\tWeek 6\t15%\nFinal exam\tExam period\t65%\nExamination hurdle\tExam period\tN/A',
};
const data = { canvas, ed, handbook };

type Item = Record<string, unknown>;
const item = (key: string, extra: Item = {}): Item => ({
  key, parentKey: null, refs: [{ platform: 'canvas', id: '5551' }], name: `Item ${key}`, kind: 'assignment', nature: 'regular',
  scoring: 'none', weight: 10, weightQuote: null, rule: null, ruleQuote: null, ...extra,
});
const documentWith = (assessments: Item[], courseExtra: Item = {}) => ({
  version: 2,
  course: { id: course.id, code: course.subjectCode, name: course.name, term: course.term, ...courseExtra },
  assessments, materials: [],
});
const raw = (document: unknown, status = 'completed') => JSON.stringify({ status, reason: '', document });
type Collected = { canvas: unknown; ed: unknown; handbook: unknown };
const check = (document: unknown, collected: Collected = data) => validateAnalysis(raw(document), { course, ...collected });
const canvasRef = (id: string) => ({ platform: 'canvas', id });

describe('validateAnalysis: shape and identity', () => {
  it('accepts a minimal valid output', () => {
    const result = check(documentWith([item('a', { weight: null })]));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid two-level document', () => {
    const result = check(documentWith([
      item('p', { refs: [], scoring: 'weighted', weight: 20 }),
      item('c1', { parentKey: 'p', refs: [canvasRef('5551')] }),
      item('c2', { parentKey: 'p', refs: [canvasRef('5552')] }),
    ]));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each([['score', 8], ['id', 'x'], ['due', null], ['status', 'graded'], ['sources', []]])('rejects a model output carrying %s', (field, value) => {
    const result = check(documentWith([item('a', { [field]: value })]));
    expect(result.valid).toBe(false);
    expect(result.issues.join('\n')).toContain('assessments.0');
  });

  it('rejects a version 1 document', () => {
    expect(check({ ...documentWith([item('a')]), version: 1 }).valid).toBe(false);
  });

  it('rejects a document for another course', () => {
    const result = check(documentWith([item('a')], { id: '900002' }));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['结果格式或课程身份不匹配']);
  });

  it('accepts a failed report with a null document', () => {
    expect(validateAnalysis(raw(null, 'failed'), { course, ...data }).valid).toBe(true);
  });

  it('rejects output that is not JSON', () => {
    const result = validateAnalysis('not json', { course, ...data });
    expect(result.valid).toBe(false);
    expect(result.report).toBeNull();
  });

  it('returns the parsed Handbook components', () => {
    expect(check(documentWith([item('a')])).components.map(component => component.name)).toEqual(['Mid‑Semester Test', 'Final exam', 'Examination hurdle']);
  });
});

describe('validateAnalysis: references', () => {
  it('names the item and the reference for IDs that were not collected', () => {
    const result = check(documentWith([
      item('a', { name: 'Quiz 9', refs: [canvasRef('999')] }),
      item('b', { refs: [{ platform: 'canvas-group', id: '301' }] }),
      item('c', { refs: [{ platform: 'ed', id: '78' }] }),
      item('d', { refs: [canvasRef('5551'), { platform: 'canvas-group', id: '300' }, { platform: 'ed', id: '77' }] }),
    ]));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      'assessments.0.refs.0: 「Quiz 9」引用的 canvas 999 不是采集到的 Canvas 作业 ID',
      'assessments.1.refs.0: 「Item b」引用的 canvas-group 301 不是采集到的 Canvas 作业分组 ID',
      'assessments.2.refs.0: 「Item c」引用的 ed 78 不是采集到的 Ed lesson ID',
    ]);
  });

  it('matches a Handbook component after normalisation and rejects a substring', () => {
    expect(check(documentWith([item('a', { refs: [{ platform: 'handbook', id: 'mid-semester  test' }] })])).issues).toEqual([]);
    expect(check(documentWith([item('a', { refs: [{ platform: 'handbook', id: 'Exam' }] })])).issues).toEqual([
      'assessments.0.refs.0: 「Item a」引用的 handbook Exam 不是 Handbook 考核表中列出的考核项名称',
    ]);
  });

  it('rejects references to sources that were not collected', () => {
    const missing = { canvas: { status: 'unavailable' }, ed: { status: 'not_found', lessons: [], scores: [] }, handbook: { status: 'unavailable' } };
    const result = check(documentWith([item('a', { refs: [canvasRef('5551'), { platform: 'canvas-group', id: '300' }, { platform: 'ed', id: '77' }, { platform: 'handbook', id: 'Final exam' }] })]), missing);
    expect(result.issues).toEqual([
      'assessments.0.refs.0: 「Item a」引用的 canvas 5551 不是采集到的 Canvas 作业 ID',
      'assessments.0.refs.1: 「Item a」引用的 canvas-group 300 不是采集到的 Canvas 作业分组 ID',
      'assessments.0.refs.2: 「Item a」引用的 ed 77 不是采集到的 Ed lesson ID',
      'assessments.0.refs.3: 「Item a」引用的 handbook Final exam 不是 Handbook 考核表中列出的考核项名称',
    ]);
  });

  it('rejects Handbook references when no component parses', () => {
    const result = check(documentWith([item('a', { refs: [{ platform: 'handbook', id: 'Final exam' }] })]), { ...data, handbook: { ...handbook, text: 'Final exam (65%)' } });
    expect(result.valid).toBe(false);
    expect(result.components).toEqual([]);
  });

  it('allows a Canvas or Ed reference on one item only', () => {
    const result = check(documentWith([
      item('a', { refs: [canvasRef('5551'), { platform: 'ed', id: '77' }] }),
      item('b', { name: 'Quiz 1 again', refs: [canvasRef('5551')] }),
      item('c', { refs: [{ platform: 'ed', id: '77' }] }),
    ]));
    expect(result.issues).toEqual([
      'assessments.1.refs.0: 「Quiz 1 again」引用的 canvas 5551 已被 assessments.0 引用，同一作业只能属于一个考核项',
      'assessments.2.refs.0: 「Item c」引用的 ed 77 已被 assessments.0 引用，同一作业只能属于一个考核项',
    ]);
  });

  it('lets Canvas group and Handbook references repeat', () => {
    const result = check(documentWith([
      item('a', { name: 'Final exam', refs: [{ platform: 'handbook', id: 'Final exam' }] }),
      item('b', { name: 'Final exam (alternative)', nature: 'alternative', refs: [{ platform: 'handbook', id: 'Final exam' }] }),
      item('c', { name: 'Quizzes', refs: [{ platform: 'canvas-group', id: '300' }] }),
      item('d', { name: 'Quiz hurdle', kind: 'hurdle', refs: [{ platform: 'canvas-group', id: '300' }] }),
    ]));
    expect(result.issues).toEqual([]);
  });

  it('rejects a leaf with no references', () => {
    const result = check(documentWith([item('a', { refs: [] })]));
    expect(result.issues).toEqual(['assessments.0.refs: 「Item a」没有任何引用，也没有子项']);
  });

  it('rejects duplicate final IDs and asks for distinct names', () => {
    const result = check(documentWith([
      item('a', { name: 'Exam', refs: [{ platform: 'handbook', id: 'Final exam' }] }),
      item('b', { name: 'Exam', refs: [{ platform: 'handbook', id: 'Final exam' }] }),
    ]));
    expect(result.issues).toEqual(['assessments.1: 生成的 ID handbook:final-exam:exam 与 assessments.0 重复，请给这些考核项不同的名称']);
  });

  it('rejects a generated ID longer than 500 characters', () => {
    const name = 'x'.repeat(490);
    const result = check(documentWith([
      item('a', { name, refs: [{ platform: 'handbook', id: 'Final exam' }] }),
      item('b', { name: 'Exam', refs: [{ platform: 'handbook', id: 'Final exam' }] }),
    ]));
    expect(result.issues).toEqual(['assessments.0: 生成的 ID 超过 500 个字符，请缩短名称']);
  });
});

describe('validateAnalysis: keys and parents', () => {
  it('rejects duplicate keys', () => {
    const result = check(documentWith([item('a'), item('a', { refs: [canvasRef('5552')] })]));
    expect(result.issues).toContain('assessments.1.key: key a 重复');
  });

  it('rejects a missing parent, a self parent and a cycle', () => {
    expect(check(documentWith([item('a', { parentKey: 'ghost' })])).issues).toEqual(['assessments.0.parentKey: parentKey 指向的考核项不存在或成环']);
    expect(check(documentWith([item('a', { parentKey: 'a' })])).issues).toEqual(['assessments.0.parentKey: parentKey 指向的考核项不存在或成环']);
    const cycle = check(documentWith([item('a', { parentKey: 'b' }), item('b', { parentKey: 'a', refs: [canvasRef('5552')] })]));
    expect(cycle.issues).toContain('assessments.0.parentKey: parentKey 指向的考核项不存在或成环');
    expect(cycle.issues).toContain('assessments.1.parentKey: parentKey 指向的考核项不存在或成环');
  });

  it('rejects three levels of nesting', () => {
    const result = check(documentWith([
      item('top', { refs: [] }), item('mid', { parentKey: 'top', refs: [] }), item('leaf', { parentKey: 'mid' }),
    ]));
    expect(result.issues).toEqual(['assessments.2.parentKey: 只支持一层父子']);
  });

  it('rejects points scoring on a child', () => {
    const result = check(documentWith([item('p', { refs: [], scoring: 'points' }), item('c', { parentKey: 'p', scoring: 'points' })]));
    expect(result.issues).toEqual(['assessments.1.scoring: 只有有计分子项的顶层父项可使用 points 或 weighted']);
  });

  it('rejects weighted scoring when a scoring child has no weight', () => {
    const result = check(documentWith([
      item('p', { refs: [], scoring: 'weighted' }),
      item('c1', { parentKey: 'p', weight: 20 }),
      item('c2', { parentKey: 'p', weight: null, refs: [canvasRef('5552')] }),
    ]));
    expect(result.issues).toEqual(['assessments.0.scoring: weighted 要求每个计分子项有明确正权重']);
  });
});

describe('analyseWithRepair', () => {
  const good = raw(documentWith([item('a')]));
  const bad = raw(documentWith([item('a', { refs: [canvasRef('999')] })]));
  const fakeModel = (outputs: string[]) => {
    const prompts: string[] = [];
    const run = async (prompt: string) => {
      prompts.push(prompt);
      return { exitCode: 0, lastMessage: outputs[prompts.length - 1], usage: { input: 10, cached: 2, output: 5, reasoning: 1 } };
    };
    return { run, prompts };
  };
  const validate = (text: string) => validateAnalysis(text, { course, ...data });

  it('stops after one call when the first output is valid', async () => {
    const model = fakeModel([good]);
    const outcome = await analyseWithRepair({ instructions: 'BASE', run: model.run, validate, isCancelled: () => false });
    expect(model.prompts).toEqual(['BASE']);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.validation.valid).toBe(true);
  });

  it('repairs once and passes', async () => {
    const model = fakeModel([bad, good]);
    const outcome = await analyseWithRepair({ instructions: 'BASE', run: model.run, validate, isCancelled: () => false });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain('BASE\n上次输出未通过校验');
    expect(model.prompts[1]).toContain('canvas 999 不是采集到的 Canvas 作业 ID');
    expect(model.prompts[1]).toContain(`上次输出：${bad}`);
    expect(outcome.validation.valid).toBe(true);
    expect(outcome.result.usage).toEqual({ input: 20, cached: 4, output: 10, reasoning: 2 });
    const settled = settleCourse({ ...outcome, collection: {}, data, previous: null });
    expect(settled.accepted).toBe(true);
    expect(settled.status).toBe('completed');
    expect(settled.document).toMatchObject({ version: 2, assessments: [{ id: 'canvas:5551' }] });
  });

  it('refuses to save and keeps the attempts when the repair still fails', async () => {
    const model = fakeModel([bad, bad, good]);
    const outcome = await analyseWithRepair({ instructions: 'BASE', run: model.run, validate, isCancelled: () => false });
    expect(model.prompts).toHaveLength(2);
    expect(outcome.attempts.map(attempt => attempt.raw)).toEqual([bad, bad]);
    const settled = settleCourse({ ...outcome, collection: {}, data, previous: null });
    expect(settled.accepted).toBe(false);
    expect(settled.status).toBe('failed');
    expect(settled.document).toBeNull();
    expect(settled.diagnostic).toEqual({ raw: bad, issues: outcome.validation.issues });
    expect(settled.reason).toContain('课程数据校验失败：');
  });

  it('does not repair after the model process fails', async () => {
    const prompts: string[] = [];
    const run = async (prompt: string) => { prompts.push(prompt); return { exitCode: 1, lastMessage: '', usage: null, error: 'boom' }; };
    const outcome = await analyseWithRepair({ instructions: 'BASE', run, validate, isCancelled: () => false });
    expect(prompts).toHaveLength(1);
    const settled = settleCourse({ ...outcome, collection: {}, data, previous: null });
    expect(settled).toMatchObject({ accepted: false, status: 'failed', reason: 'boom' });
  });
});

describe('settleCourse', () => {
  const settle = async (output: string, collection = {}, collected: Collected = data) => {
    const outcome = await analyseWithRepair({
      instructions: 'BASE',
      run: async () => ({ exitCode: 0, lastMessage: output, usage: null }),
      validate: text => validateAnalysis(text, { course, ...collected }),
      isCancelled: () => false,
    });
    return settleCourse({ ...outcome, collection, data: collected, previous: null });
  };

  it('downgrades completed to partial when a collector failed', async () => {
    expect(await settle(raw(documentWith([item('a')])), { edFailed: true })).toMatchObject({ accepted: true, status: 'partial', reason: 'Ed 数据未能读取；' });
  });

  it('downgrades to partial when the Handbook was collected but no component parsed', async () => {
    const unparsed = { ...data, handbook: { ...handbook, text: 'Final exam (65%)' } };
    expect(await settle(raw(documentWith([item('a')])), {}, unparsed)).toMatchObject({ accepted: true, status: 'partial', reason: 'Handbook 考核表未能解析；' });
    const failed = { ...data, handbook: { status: 'unavailable' } };
    expect(await settle(raw(documentWith([item('a')])), { handbookFailed: true }, failed)).toMatchObject({ status: 'partial', reason: 'Handbook 数据未能读取；' });
  });

  it('keeps a failed report as a diagnostic without saving a document', async () => {
    const settled = await settle(JSON.stringify({ status: 'failed', reason: '数据不足', document: null }));
    expect(settled).toMatchObject({ accepted: true, status: 'failed', reason: '数据不足', document: null });
    expect(settled.diagnostic?.issues).toEqual([]);
  });
});
