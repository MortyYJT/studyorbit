import { describe, expect, it } from 'vitest';
import { chatSystemPrompt } from '../scripts/lib/chat-context.mjs';
import { buildCourseIndex } from '../scripts/lib/chat-tools-prompt.mjs';
import type { CourseDocument } from '../shared/course-data.js';

// Tool mode (decision #323): the prompt asks for lookups instead of arithmetic and carries only a course index.
// Synthetic data only.
type Item = Extract<CourseDocument, { version: 2 }>['assessments'][number];
const item = (patch: Partial<Item> & { id: string; name: string }): Item => ({
  kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: null,
  status: 'unknown', scoring: 'none', rule: null, sources: [], refs: [], weightQuote: null, ruleQuote: null, unsourced: [], ...patch,
});
const synthetic: CourseDocument = {
  version: 2, course: { id: 'syn-1', code: 'SYN10001', name: 'Synthetic Systems', term: '2026 Semester 2' }, materials: [], legacyIds: {},
  assessments: [
    item({ id: 'a1', name: 'Assignment Zeta', weight: 20, score: 17.5, maxScore: 20, status: 'graded' }),
    item({ id: 'exam', name: 'Final exam Omega', kind: 'test', weight: 80, rule: 'Hurdle 40%' }),
  ],
};
const courses = [{ id: 'syn-2', code: 'SYN20002', name: 'Synthetic Data' }];

describe('tool-mode system prompt', () => {
  for (const language of ['zh', 'en'] as const) {
    it(`asks for tool lookups and has no formula wording (${language})`, () => {
      const prompt = chatSystemPrompt(language, 'tools');
      expect(prompt).not.toContain('写出算式');
      expect(prompt).not.toContain('show the arithmetic');
      expect(prompt).toMatch(language === 'zh' ? /工具/ : /tool/);
      expect(prompt).toMatch(language === 'zh' ? /不确定/ : /not sure/);
      expect(prompt).toContain('whatIfApplied');
      // Same role and refusal lines as context mode.
      expect(prompt.split('\n').slice(0, 3)).toEqual(chatSystemPrompt(language).split('\n').slice(0, 3));
    });
  }

  it('leaves the context-mode prompt unchanged', () => {
    expect(chatSystemPrompt('zh', 'context')).toBe(chatSystemPrompt('zh'));
    expect(chatSystemPrompt('en', 'context')).toBe(chatSystemPrompt('en'));
  });
});

describe('buildCourseIndex', () => {
  it('lists scope courses with ID, code, name, term and sync state, but no assessment facts', () => {
    const index = buildCourseIndex({ documents: [synthetic], courses, scope: ['syn-1', 'syn-2'], today: '2026-09-14', planning: null });
    expect(index).toContain('2026-09-14');
    expect(index).toMatch(/syn-1.*SYN10001.*Synthetic Systems.*2026 Semester 2/);
    expect(index).toMatch(/syn-2.*SYN20002.*Synthetic Data/);
    expect(index).toContain('有同步数据');
    expect(index).toContain('没有同步数据');
    for (const fact of ['Assignment Zeta', 'Final exam Omega', '17.5', 'Hurdle 40%', '20%', '80']) expect(index).not.toContain(fact);
    expect(index).toContain('没有附带计划数据');
  });

  it('says how many planning tasks are attached and when the list was cut', () => {
    const planning = { tasks: [{ key: 'k1', title: 't', courseId: '', courseCode: '', due: '2026-09-20', minutes: 60 }], availability: [60, 60, 60, 60, 60, 0, 0], targets: {} };
    expect(buildCourseIndex({ documents: [], courses, scope: ['syn-2'], today: '2026-09-14', planning })).toMatch(/1 个未完成任务/);
    const cut = buildCourseIndex({ documents: [], courses, scope: [], today: '2026-09-14', planning: { ...planning, omitted: 3 } });
    expect(cut).toMatch(/另有 3 个/);
    expect(cut).toContain('当前没有选择任何课程');
  });
});
