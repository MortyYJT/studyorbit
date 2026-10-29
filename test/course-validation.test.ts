import { describe, expect, it } from 'vitest';
import { analyseWithRepair, settleCourse, validateAnalysis } from '../scripts/lib/course-validation.mjs';

// Synthetic course and collected data only; no real course content.
const course = { id: '900001', subjectCode: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' };
const noData: { canvas: unknown; ed: unknown } = { canvas: {}, ed: { lessons: [], scores: [] } };

type Item = Record<string, unknown>;
const item = (id: string, extra: Item = {}): Item => ({
  id, name: `Item ${id}`, kind: 'assignment', nature: 'regular', parentId: null, weight: 10,
  score: null, maxScore: null, due: null, status: 'unknown', scoring: 'none', rule: null, sources: [], ...extra,
});
const documentWith = (assessments: Item[], courseExtra: Item = {}) => ({
  version: 1,
  course: { id: course.id, code: course.subjectCode, name: course.name, term: course.term, ...courseExtra },
  assessments, materials: [],
});
const raw = (document: unknown, status = 'completed') => JSON.stringify({ status, reason: '', document });
const check = (document: unknown, data = noData) => validateAnalysis(raw(document), { course, ...data });

describe('validateAnalysis', () => {
  it('accepts a valid two-level document', () => {
    const result = check(documentWith([
      item('p', { scoring: 'weighted', weight: 40 }),
      item('c1', { parentId: 'p', weight: 20 }),
      item('c2', { parentId: 'p', weight: 20 }),
    ]));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects duplicate assessment IDs', () => {
    const result = check(documentWith([item('a'), item('a')]));
    expect(result.valid).toBe(false);
    expect(result.issues.join('\n')).toContain('assessment ids must be unique');
  });

  it('rejects a score above the maximum', () => {
    const result = check(documentWith([item('a', { score: 11, maxScore: 10 })]));
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('assessments.0.score: score exceeds maximum');
  });

  it('rejects a missing parent', () => {
    const result = check(documentWith([item('a', { parentId: 'ghost' })]));
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('assessments.0.parentId: parent missing or cyclic');
  });

  it('rejects a parent cycle', () => {
    const result = check(documentWith([item('a', { parentId: 'b' }), item('b', { parentId: 'a' })]));
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('assessments.0.parentId: parent missing or cyclic');
    expect(result.issues).toContain('assessments.1.parentId: parent missing or cyclic');
  });

  it('rejects three levels of nesting', () => {
    const result = check(documentWith([item('top'), item('mid', { parentId: 'top' }), item('leaf', { parentId: 'mid' })]));
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('assessments.2.parentId: only one parent level is supported');
  });

  it('rejects points scoring on a child', () => {
    const result = check(documentWith([
      item('p', { scoring: 'points' }),
      item('c', { parentId: 'p', scoring: 'points' }),
    ]));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['assessments.1.scoring: 只有有计分子项的顶层父项可使用 points 或 weighted']);
  });

  it('rejects weighted scoring when a scoring child has no weight', () => {
    const result = check(documentWith([
      item('p', { scoring: 'weighted' }),
      item('c1', { parentId: 'p', weight: 20 }),
      item('c2', { parentId: 'p', weight: null }),
    ]));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['assessments.0.scoring: weighted 要求每个计分子项有明确正权重']);
  });

  it('rejects an Ed score paired with another maximum', () => {
    const ed = {
      lessons: [{ id: 77, url: 'https://edstem.example/lessons/77' }],
      scores: [{ lessonId: 77, status: 'graded', score: 8, maxScore: 10 }],
    };
    const document = documentWith([item('q', {
      kind: 'quiz', score: 8, maxScore: 12, sources: [{ platform: 'ed', url: 'https://edstem.example/lessons/77', evidence: null }],
    })]);
    const result = check(document, { canvas: {}, ed });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['assessments.0: Ed 已得 8/10，请使用同一来源的得分和满分']);
  });

  it('accepts the Ed score when Canvas confirms the same score and maximum', () => {
    const ed = {
      lessons: [{ id: 77, url: 'https://edstem.example/lessons/77' }],
      scores: [{ lessonId: 77, status: 'graded', score: 8, maxScore: 10 }],
    };
    const canvas = { assignments: [{ html_url: 'https://canvas.example/a/5', points_possible: 12, submission: { score: 8 } }] };
    const document = documentWith([item('q', {
      score: 8, maxScore: 12, sources: [
        { platform: 'ed', url: 'https://edstem.example/lessons/77', evidence: null },
        { platform: 'canvas', url: 'https://canvas.example/a/5', evidence: null },
      ],
    })]);
    expect(check(document, { canvas, ed }).valid).toBe(true);
  });

  it('rejects a document for another course', () => {
    const result = check(documentWith([item('a')], { id: '900002' }));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(['结果格式或课程身份不匹配']);
  });

  it('accepts a failed report with a null document', () => {
    const result = validateAnalysis(raw(null, 'failed'), { course, ...noData });
    expect(result.valid).toBe(true);
  });

  it('rejects output that is not JSON', () => {
    const result = validateAnalysis('not json', { course, ...noData });
    expect(result.valid).toBe(false);
    expect(result.report).toBeNull();
  });
});

describe('analyseWithRepair', () => {
  const good = raw(documentWith([item('a')]));
  const bad = raw(documentWith([item('a'), item('a')]));
  const fakeModel = (outputs: string[]) => {
    const prompts: string[] = [];
    const run = async (prompt: string) => {
      prompts.push(prompt);
      return { exitCode: 0, lastMessage: outputs[prompts.length - 1], usage: { input: 10, cached: 2, output: 5, reasoning: 1 } };
    };
    return { run, prompts };
  };
  const validate = (text: string) => validateAnalysis(text, { course, ...noData });

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
    expect(model.prompts[1]).toContain('assessment ids must be unique');
    expect(model.prompts[1]).toContain(`上次输出：${bad}`);
    expect(outcome.validation.valid).toBe(true);
    expect(outcome.result.usage).toEqual({ input: 20, cached: 4, output: 10, reasoning: 2 });
    const settled = settleCourse({ ...outcome, collection: {} });
    expect(settled.accepted).toBe(true);
    expect(settled.status).toBe('completed');
    expect(settled.document).not.toBeNull();
  });

  it('refuses to save and keeps the attempts when the repair still fails', async () => {
    const model = fakeModel([bad, bad, good]);
    const outcome = await analyseWithRepair({ instructions: 'BASE', run: model.run, validate, isCancelled: () => false });
    expect(model.prompts).toHaveLength(2);
    expect(outcome.attempts.map(attempt => attempt.raw)).toEqual([bad, bad]);
    const settled = settleCourse({ ...outcome, collection: {} });
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
    const settled = settleCourse({ ...outcome, collection: {} });
    expect(settled).toMatchObject({ accepted: false, status: 'failed', reason: 'boom' });
  });
});

describe('settleCourse', () => {
  it('downgrades completed to partial when a collector failed', async () => {
    const outcome = await analyseWithRepair({
      instructions: 'BASE',
      run: async () => ({ exitCode: 0, lastMessage: raw(documentWith([item('a')])), usage: null }),
      validate: text => validateAnalysis(text, { course, ...noData }),
      isCancelled: () => false,
    });
    const settled = settleCourse({ ...outcome, collection: { edFailed: true } });
    expect(settled).toMatchObject({ accepted: true, status: 'partial', reason: 'Ed 数据未能读取；' });
  });

  it('keeps a failed report as a diagnostic without saving a document', async () => {
    const outcome = await analyseWithRepair({
      instructions: 'BASE',
      run: async () => ({ exitCode: 0, lastMessage: JSON.stringify({ status: 'failed', reason: '数据不足', document: null }), usage: null }),
      validate: text => validateAnalysis(text, { course, ...noData }),
      isCancelled: () => false,
    });
    const settled = settleCourse({ ...outcome, collection: {} });
    expect(settled).toMatchObject({ accepted: true, status: 'failed', reason: '数据不足', document: null });
    expect(settled.diagnostic?.issues).toEqual([]);
  });
});
