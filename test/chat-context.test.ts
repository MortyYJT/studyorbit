import { describe, expect, it } from 'vitest';
import { buildChatContext, chatSystemPrompt, CONTEXT_LIMIT } from '../scripts/lib/chat-context.mjs';
import { toDisplayDocument, type CourseDocument } from '../shared/course-data.js';

type Item = CourseDocument['assessments'][number];
const item = (patch: Partial<Item> & { id: string; name: string }): Item => ({
  kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: null,
  status: 'unknown', scoring: 'none', rule: null, sources: [], ...patch,
});
const doc = (id: string, code: string, assessments: Item[]): CourseDocument => ({
  version: 1, course: { id, code, name: 'Synthetic Systems', term: '2026 Semester 2' }, assessments, materials: [],
});

const synthetic = doc('syn-1', 'SYN10001', [
  item({ id: 'a1', name: 'Assignment 1', weight: 20, score: 16, maxScore: 20, due: '2026-08-20', status: 'graded' }),
  item({ id: 'quizzes', name: 'Weekly quizzes', kind: 'quiz', weight: 10, scoring: 'points' }),
  item({ id: 'q1', name: 'Quiz 1', kind: 'quiz', parentId: 'quizzes', score: 4, maxScore: 5, status: 'graded' }),
  item({ id: 'q2', name: 'Quiz 2', kind: 'quiz', parentId: 'quizzes', score: 5, maxScore: 5, status: 'graded' }),
  item({ id: 'bonus', name: 'Bonus challenge', nature: 'bonus', maxScore: 2 }),
  item({ id: 'exam', name: 'Final exam', kind: 'test', weight: 70, due: '2026-11-10', status: 'not_started', rule: 'Hurdle: at least 40% on the exam' }),
  item({ id: 'hurdle', name: 'Lab attendance', kind: 'hurdle', nature: 'ungraded' }),
]);

describe('buildChatContext', () => {
  it('lists each course with its assessments, weights, scores, dates, grouping and flags', () => {
    const text = buildChatContext([synthetic], { today: '2026-10-29', courseIds: ['syn-1'] });
    expect(text).toContain('2026-10-29');
    expect(text).toContain('SYN10001');
    expect(text).toContain('Synthetic Systems');
    expect(text).toContain('2026 Semester 2');
    expect(text).toMatch(/Assignment 1.*20%.*16\/20.*2026-08-20/);
    expect(text).toMatch(/Quiz 1/);
    expect(text).toMatch(/Weekly quizzes/);
    // Children are listed under their parent.
    expect(text.indexOf('Quiz 1')).toBeGreaterThan(text.indexOf('Weekly quizzes'));
    expect(text).toMatch(/Bonus challenge.*加分/);
    expect(text).toMatch(/Lab attendance.*不计分/);
    expect(text).toMatch(/Final exam.*Hurdle: at least 40%/);
    expect(text).toMatch(/Final exam.*未开始/);
  });

  it('adds the graded weight and earned marks computed from the document', () => {
    const text = buildChatContext([synthetic], { today: '2026-10-29', courseIds: ['syn-1'] });
    // Assignment 1: 20 * 16/20 = 16; quizzes: 10 * 9/10 = 9. Graded weight 30, earned 25.
    expect(text).toContain('已出分权重 30%');
    expect(text).toContain('已得 25 分');
  });

  it('only includes the requested courses and says when a selected course has no data', () => {
    const other = doc('syn-2', 'SYN20002', [item({ id: 'x', name: 'Other task' })]);
    const text = buildChatContext([synthetic, other], { today: '2026-10-29', courseIds: ['syn-2', 'syn-3'] });
    expect(text).toContain('SYN20002');
    expect(text).not.toContain('SYN10001');
    expect(text).toContain('syn-3');
  });

  it('describes a v2 document and a display document the same way as the v1 document', () => {
    const v2: CourseDocument = { ...synthetic, version: 2, legacyIds: {},
      assessments: synthetic.assessments.map(entry => ({ ...entry, refs: [], weightQuote: null, ruleQuote: null, unsourced: [] })) };
    const expected = buildChatContext([synthetic], { today: '2026-10-29' });
    expect(buildChatContext([v2], { today: '2026-10-29' })).toBe(expected);
    expect(buildChatContext([toDisplayDocument(synthetic)], { today: '2026-10-29' })).toBe(expected);
  });

  it('caps the text and appends a truncation note', () => {
    const many = doc('syn-big', 'SYN30003', Array.from({ length: 2000 }, (_, index) => item({ id: `t${index}`, name: `Synthetic task number ${index} with a long name`, weight: 0.01 })));
    const text = buildChatContext([many], { today: '2026-10-29', courseIds: ['syn-big'] });
    expect(text.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
    expect(text).toContain('已截断');
  });
});

describe('chatSystemPrompt', () => {
  it('forbids completing graded work and inventing data in both languages', () => {
    const zh = chatSystemPrompt('zh');
    expect(zh).toMatch(/不.*代写/);
    expect(zh).toContain('不确定');
    expect(zh).toMatch(/不.*提交/);
    const en = chatSystemPrompt('en');
    expect(en).toMatch(/never write or complete graded work/i);
    expect(en).toMatch(/do not invent/i);
  });
});
