import { describe, expect, it } from 'vitest';
import {
  SCORED_FIELDS, consistency, interceptionCounts, matchAssessments, normaliseIssue, normaliseName, scoreDocument, summariseCourse, summariseOverall,
} from '../scripts/lib/eval-score.mjs';

// Fixed, synthetic model outputs only; no network and no real course data.
type Item = { id: string; name: string; [key: string]: unknown };
const item = (id: string, extra: Record<string, unknown> = {}): Item => ({
  id, name: `Item ${id}`, kind: 'assignment', nature: 'regular', parentId: null, weight: 10,
  score: null, maxScore: 10, due: null, status: 'unknown', scoring: 'none', rule: null, sources: [], ...extra,
});
const doc = (assessments: Item[]) => ({
  version: 1 as const,
  course: { id: '900001', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' },
  assessments, materials: [],
});
const gold = doc([
  item('group', { name: 'Weekly Quizzes', kind: 'quiz', weight: 20, maxScore: null, scoring: 'weighted' }),
  item('q1', { name: 'Quiz 1', kind: 'quiz', parentId: 'group', score: 8, due: '2026-08-07T23:59:00+10:00', status: 'graded' }),
  item('q2', { name: 'Quiz 2', kind: 'quiz', parentId: 'group', due: '2026-09-20T23:59:00+10:00', status: 'not_started' }),
  item('a1', { name: 'Assignment 1', weight: 30, score: 24, maxScore: 30, status: 'graded' }),
]);
const cells = gold.assessments.length * SCORED_FIELDS.length;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const edit = (id: string, change: Record<string, unknown>) => {
  const copy = clone(gold);
  Object.assign(copy.assessments.find(entry => entry.id === id)!, change);
  return copy;
};

describe('normalisation helpers', () => {
  it('normalises names by case, whitespace and punctuation', () => {
    expect(normaliseName('  Assignment-1:  Report ')).toBe('assignment 1 report');
    expect(normaliseName('QUIZ 1.')).toBe(normaliseName('quiz 1'));
  });

  it('strips the assessment index prefix from issues', () => {
    expect(normaliseIssue('assessments.3.score: score exceeds maximum')).toBe('score: score exceeds maximum');
    expect(normaliseIssue('assessments.12: Ed 已得 24/30，请使用同一来源的得分和满分')).toBe('Ed 已得 24/30，请使用同一来源的得分和满分');
    expect(normaliseIssue('assessment ids must be unique')).toBe('assessment ids must be unique');
  });
});

describe('scoreDocument', () => {
  it('scores a perfect match as fully correct', () => {
    const score = scoreDocument(gold, clone(gold));
    expect(score.correct).toBe(cells);
    expect(score.cells).toBe(cells);
    expect(score.fieldAccuracy).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.mismatches).toEqual([]);
  });

  it('counts a wrong weight as one wrong cell and tolerates float noise', () => {
    const score = scoreDocument(gold, edit('a1', { weight: 35, score: 24 + 1e-9 }));
    expect(score.correct).toBe(cells - 1);
    expect(score.perField.weight).toEqual({ correct: 3, total: 4 });
    expect(score.perField.score).toEqual({ correct: 4, total: 4 });
    expect(score.mismatches).toEqual([{ goldId: 'a1', field: 'weight', expected: 30, actual: 35 }]);
  });

  it('counts a missing assessment as all fields wrong and lowers recall', () => {
    const predicted = clone(gold);
    predicted.assessments = predicted.assessments.filter(entry => entry.id !== 'a1');
    const score = scoreDocument(gold, predicted);
    expect(score.correct).toBe(cells - SCORED_FIELDS.length);
    expect(score.recall).toBe(3 / 4);
    expect(score.precision).toBe(1);
    expect(score.unmatchedGold).toEqual(['a1']);
  });

  it('lowers precision for an extra assessment without changing accuracy', () => {
    const predicted = clone(gold);
    predicted.assessments.push(item('practice', { name: 'Week 1 Practice' }));
    const score = scoreDocument(gold, predicted);
    expect(score.fieldAccuracy).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(4 / 5);
    expect(score.extraPredicted).toEqual(['practice']);
  });

  it('matches by normalised name when ids differ and maps parents through the match', () => {
    const predicted = clone(gold);
    for (const entry of predicted.assessments) {
      if (entry.id === 'group') { entry.id = '501'; entry.name = 'weekly   quizzes!'; }
      if (entry.parentId === 'group') entry.parentId = '501';
    }
    const score = scoreDocument(gold, predicted);
    expect(score.fieldAccuracy).toBe(1);
    expect(matchAssessments(gold.assessments, predicted.assessments).map(pair => [pair.gold.id, pair.predicted?.id])).toEqual([
      ['group', '501'], ['q1', 'q1'], ['q2', 'q2'], ['a1', 'a1'],
    ]);
  });

  it('marks a parent wrong when the predicted parent maps to another gold item', () => {
    const score = scoreDocument(gold, edit('q2', { parentId: 'a1' }));
    expect(score.mismatches).toEqual([{ goldId: 'q2', field: 'parentId', expected: 'group', actual: 'a1' }]);
  });

  it('matches each gold item at most once', () => {
    const predicted = doc([item('x', { name: 'Quiz 1' }), item('y', { name: 'Quiz 1' })]);
    const pairs = matchAssessments(gold.assessments, predicted.assessments);
    expect(pairs.filter(pair => pair.predicted).length).toBe(1);
  });

  it('compares due dates by date part only', () => {
    expect(scoreDocument(gold, edit('q2', { due: '2026-09-20T13:59:00Z' })).fieldAccuracy).toBe(1);
    expect(scoreDocument(gold, edit('q2', { due: '2026-09-21' })).mismatches)
      .toEqual([{ goldId: 'q2', field: 'due', expected: '2026-09-20', actual: '2026-09-21' }]);
    expect(scoreDocument(gold, edit('a1', { due: '2026-08-28' })).mismatches)
      .toEqual([{ goldId: 'a1', field: 'due', expected: null, actual: '2026-08-28' }]);
  });
});

describe('consistency', () => {
  it('reports cell agreement and identical runs across three runs with one disagreeing', () => {
    const result = consistency(gold, [clone(gold), edit('a1', { weight: 35 }), clone(gold)]);
    expect(result.cells).toBe(cells);
    expect(result.agreeingCells).toBe(cells - 1);
    expect(result.cellAgreement).toBe((cells - 1) / cells);
    expect(result.identicalRuns).toBe(2);
    expect(result.identicalToFirst).toBe(2 / 3);
  });

  it('treats a missing match as its own value and skips runs without a document', () => {
    const missing = clone(gold);
    missing.assessments = missing.assessments.filter(entry => entry.id !== 'a1');
    const result = consistency(gold, [clone(gold), null, missing]);
    expect(result.documentRuns).toBe(2);
    expect(result.agreeingCells).toBe(cells - SCORED_FIELDS.length);
    expect(result.identicalToFirst).toBe(1 / 3);
  });

  it('ignores free text and order when comparing whole documents', () => {
    const reordered = clone(gold);
    reordered.assessments.reverse();
    reordered.assessments[0].rule = 'Different wording';
    expect(consistency(gold, [clone(gold), reordered]).identicalToFirst).toBe(1);
  });

  it('returns null rates when no run produced a document', () => {
    expect(consistency(gold, [null, null])).toMatchObject({ cellAgreement: null, identicalToFirst: null, documentRuns: 0 });
  });
});

describe('interceptionCounts', () => {
  it('counts repairs, rejections and grouped issues', () => {
    const counts = interceptionCounts([
      { accepted: true, attempts: [{ issues: ['assessments.3: Ed 已得 24/30，请使用同一来源的得分和满分'] }, { issues: [] }] },
      { accepted: true, attempts: [{ issues: [] }] },
      { accepted: false, attempts: [
        { issues: ['assessments.1.score: score exceeds maximum', 'assessment ids must be unique'] },
        { issues: ['assessments.4.score: score exceeds maximum'] },
      ] },
    ]);
    expect(counts).toEqual({
      runs: 3, repairTriggered: 2, rejected: 1, failed: 0,
      issues: { 'Ed 已得 24/30，请使用同一来源的得分和满分': 1, 'score: score exceeds maximum': 2, 'assessment ids must be unique': 1 },
    });
  });
});

describe('interceptionCounts with model failures', () => {
  it('counts failed runs apart from rejected ones and ignores issues of failed attempts', () => {
    const counts = interceptionCounts([
      { accepted: false, failed: true, attempts: [{ exitCode: 1, issues: [': Invalid input: expected object, received undefined'] }] },
      { accepted: false, failed: true, attempts: [] },
      { accepted: false, attempts: [{ exitCode: 0, issues: ['assessment ids must be unique'] }, { exitCode: null, issues: ['ignored'] }] },
    ]);
    expect(counts).toEqual({ runs: 3, repairTriggered: 1, rejected: 1, failed: 2, issues: { 'assessment ids must be unique': 1 } });
  });
});

describe('summaries', () => {
  const run = (document: ReturnType<typeof doc> | null, extra: Record<string, unknown> = {}) => ({
    accepted: true, document, attempts: [{ issues: [] }], durationMs: 100, usage: { input: 10, cached: null, output: 5, reasoning: null }, ...extra,
  });

  it('pools accuracy over runs with a document and sums usage', () => {
    const summary = summariseCourse(gold, [
      run(clone(gold)),
      run(edit('a1', { weight: 35 })),
      run(null, { accepted: false, attempts: [{ issues: ['x'] }, { issues: ['x'] }], usage: null }),
    ]);
    expect(summary.runs).toBe(3);
    expect(summary.documentRuns).toBe(2);
    expect(summary.fieldAccuracy).toBe((2 * cells - 1) / (2 * cells));
    expect(summary.perField.weight).toBe(7 / 8);
    expect(summary.interception).toMatchObject({ repairTriggered: 1, rejected: 1, failed: 0, issues: { x: 2 } });
    expect(summary.tokens).toEqual({ input: 20, output: 10, runsWithUsage: 2 });
    expect(summary.durationMs).toEqual({ total: 300, mean: 100 });
  });

  it('pools course summaries into an overall summary', () => {
    const one = summariseCourse(gold, [run(clone(gold))]);
    const two = summariseCourse(gold, [run(edit('a1', { weight: 35 })), run(null, { accepted: false, attempts: [{ issues: ['x'] }, { issues: ['x'] }] })]);
    const overall = summariseOverall([one, two]);
    expect(overall.courses).toBe(2);
    expect(overall.runs).toBe(3);
    expect(overall.fieldAccuracy).toBe((2 * cells - 1) / (2 * cells));
    expect(overall.interception).toMatchObject({ runs: 3, repairTriggered: 1, rejected: 1, failed: 0, issues: { x: 2 } });
    expect(overall.cellAgreement).toBe(1);
  });
});
