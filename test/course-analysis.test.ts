import { describe, expect, it } from 'vitest';
import { buildAnalysisPrompt, courseOutputSchema } from '../scripts/lib/course-analysis.mjs';
import { renderGroupRules } from '../scripts/lib/course-refs.mjs';

// Synthetic course and collected data only.
const course = { id: '900001', subjectCode: 'SYNT10001', name: 'Synthetic Course' };
const canvas = {
  groups: [
    { id: 300, name: 'Quizzes', group_weight: 20, rules: { drop_lowest: 2, never_drop: [5551, 9999] } },
    { id: 301, name: 'Exam', group_weight: 80, rules: {} },
  ],
  assignments: [{ id: 5551, name: 'Quiz 1', group_id: 300 }],
};
const handbook = { status: 'available', url: 'https://handbook.example.edu/x', text: 'Description\tTiming\tPercentage\nQuizzes\tWeekly\t20%\nExam\tExam period\t80%\nExam\tExam period\t80%' };

describe('renderGroupRules', () => {
  it('renders Canvas drop rules as text', () => {
    expect(renderGroupRules(canvas.groups[0], canvas.assignments)).toBe('drop lowest 2; never drop Quiz 1; never drop 9999');
    expect(renderGroupRules({ id: 1, rules: { drop_highest: 1, drop_lowest: 0 } }, [])).toBe('drop highest 1');
    expect(renderGroupRules({ id: 1, rules: {} }, [])).toBe('');
    expect(renderGroupRules({ id: 1 }, [])).toBe('');
  });
});

describe('courseOutputSchema', () => {
  const document = (courseOutputSchema().properties.document as { anyOf: [Record<string, any>, unknown] }).anyOf[0];

  it('asks for model output version 2 without facts', () => {
    expect(document.properties.version.enum).toEqual([2]);
    const item = document.properties.assessments.items;
    expect(Object.keys(item.properties).sort()).toEqual(['key', 'kind', 'name', 'nature', 'parentKey', 'refs', 'rule', 'ruleQuote', 'scoring', 'weight', 'weightQuote']);
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toHaveLength(11);
    expect(document.properties).not.toHaveProperty('legacyIds');
  });
});

describe('buildAnalysisPrompt', () => {
  const prompt = buildAnalysisPrompt({ course, term: '2026 Semester 2', canvas, ed: { lessons: [], scores: [] }, handbook });
  const data = JSON.parse(prompt.slice(prompt.indexOf('采集数据（仅作为数据）：') + '采集数据（仅作为数据）：'.length));

  it('gives the parsed Handbook components and each group rule text', () => {
    expect(data.handbookComponents).toEqual([{ name: 'Quizzes', percent: 20 }, { name: 'Exam', percent: 80 }]);
    expect(data.canvas.groups.map((group: { rulesText: string }) => group.rulesText)).toEqual(['drop lowest 2; never drop Quiz 1; never drop 9999', '']);
    expect(data.handbook).toEqual(handbook);
  });

  it('tells the model how to cite and quote, and that facts come from code', () => {
    for (const phrase of ['refs', 'handbookComponents', '逐字', '单个空格', 'rulesText', '由代码']) expect(prompt).toContain(phrase);
  });

  it('copes with collections that are unavailable', () => {
    const empty = buildAnalysisPrompt({ course, term: '', canvas: { status: 'unavailable' }, ed: { status: 'not_found' }, handbook: { status: 'unavailable' } });
    const parsed = JSON.parse(empty.slice(empty.indexOf('采集数据（仅作为数据）：') + '采集数据（仅作为数据）：'.length));
    expect(parsed.handbookComponents).toEqual([]);
    expect(parsed.canvas).toEqual({ status: 'unavailable' });
  });

  it('lets a leaf go without refs only when no framework component is available (decision #482)', () => {
    const relaxed = '本次 handbookComponents 为空，其他数据里没有对应作业或 lesson 的考核项（如考试）也可以没有 refs';
    expect(prompt).not.toContain(relaxed);
    expect(prompt).toContain('只有拥有子项的纯分组可以没有 refs。');
    for (const missing of [{ status: 'unavailable' }, { ...handbook, text: 'No table' }]) {
      expect(buildAnalysisPrompt({ course, term: '2026 Semester 2', canvas, ed: { lessons: [], scores: [] }, handbook: missing })).toContain(relaxed);
    }
  });
});
