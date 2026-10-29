import { describe, expect, it } from 'vitest';
import { buildChatContext, chatSystemPrompt } from '../scripts/lib/chat-context.mjs';
import type { CourseDocument } from '../shared/course-data.js';

// Context mode (Codex and the tool fallback) must stay byte-identical so the Q&A "before" numbers can be reproduced.
// Synthetic data only.
type Item = Extract<CourseDocument, { version: 2 }>['assessments'][number];
const item = (patch: Partial<Item> & { id: string; name: string }): Item => ({
  kind: 'assignment', nature: 'regular', parentId: null, weight: null, score: null, maxScore: null, due: null,
  status: 'unknown', scoring: 'none', rule: null, sources: [], refs: [], weightQuote: null, ruleQuote: null, unsourced: [], ...patch,
});
const synthetic: CourseDocument = {
  version: 2, course: { id: 'syn-1', code: 'SYN10001', name: 'Synthetic Systems', term: '2026 Semester 2' }, materials: [], legacyIds: {},
  assessments: [
    item({ id: 'a1', name: 'Assignment 1', weight: 20, score: 15, maxScore: 20, due: '2026-08-20T13:59:00Z', status: 'graded' }),
    item({ id: 'quizzes', name: 'Weekly quizzes', kind: 'quiz', weight: 30, scoring: 'points' }),
    item({ id: 'q1', name: 'Quiz 1', kind: 'quiz', parentId: 'quizzes', score: 8, maxScore: 10, status: 'graded' }),
    item({ id: 'q2', name: 'Quiz 2', kind: 'quiz', parentId: 'quizzes', score: 6, maxScore: 10, status: 'submitted' }),
    item({ id: 'bonus', name: 'Bonus challenge', nature: 'bonus', maxScore: 2 }),
    item({ id: 'alt', name: 'Alternative exam', kind: 'test', nature: 'alternative', weight: 50 }),
    item({ id: 'part', name: 'Participation', kind: 'participation', unsourced: ['weight'] }),
    item({ id: 'exam', name: 'Final exam', kind: 'test', weight: 50, maxScore: 100, due: '2026-11-10', status: 'not_started', rule: 'Hurdle:  at least 40%\non the exam' }),
    item({ id: 'hurdle', name: 'Lab attendance', kind: 'hurdle', nature: 'ungraded', status: 'in_progress' }),
  ],
};

describe('context mode is pinned', () => {
  it('keeps the Chinese system prompt', () => {
    expect(chatSystemPrompt('zh')).toMatchInlineSnapshot(`
      "你是一名墨尔本大学学生的学习助手，运行在他自己的课程管理工具里。
      你可以：解释成绩和权重，计算剩余项目需要拿多少分，制定每周学习计划，出复习题，讲解概念。
      你不代写也不完成任何计分作业（作业、论文、测验或考试答案、要提交的代码），也不提交任何东西。被要求时用一句话说明，然后提出可以讲解概念或帮忙规划。
      只根据下面的课程数据回答。数据缺失或不清楚时直接说不确定，不要编造分数、权重或日期；计算时写出算式。
      用用户使用的语言回答。简洁，用短段落和简单列表。"
    `);
  });

  it('keeps the English system prompt', () => {
    expect(chatSystemPrompt('en')).toMatchInlineSnapshot(`
      "You are a study assistant for one University of Melbourne student, inside their personal coursework tool.
      You help with: explaining grades and weights, working out what score is needed on the remaining items, weekly study plans, revision questions and explaining concepts.
      You never write or complete graded work (assignments, essays, quiz or exam answers, code to be submitted) and never submit anything. If asked, say so in one sentence and offer to explain the concept or help plan instead.
      Answer from the course data below. If the data is missing or unclear, say you are not sure. Do not invent scores, weights or dates; show the arithmetic when you calculate.
      Reply in the user's language. Be concise; use short paragraphs and simple lists."
    `);
  });

  it('keeps the course context', () => {
    expect(buildChatContext([synthetic], { today: '2026-10-29', courseIds: ['syn-1', 'syn-2'], courses: [{ id: 'syn-2', code: 'SYN20002', name: 'Synthetic Data' }] })).toMatchInlineSnapshot(`
      "今天：2026-10-29（墨尔本时间）。
      以下是同步得到的课程数据，不包含用户在页面上做的修改。分数是原始得分/满分，权重是占课程总分的百分比。

      ## SYN10001 Synthetic Systems（2026 Semester 2）
      已出分权重 50%，已得 36 分（总分 100），已出分部分平均 72%。
      标「权重无出处」「规则无出处」的项目：同步时没有在采集数据里找到依据，值已留空，不要当作已确认的信息。
      - Assignment 1｜作业｜权重 20%｜得分 15/20｜截止 2026-08-20 23:59｜已出分
      - Weekly quizzes｜测验｜权重 30%｜计分：按子项原始分合计
        - Quiz 1｜测验｜得分 8/10｜已出分
        - Quiz 2｜测验｜得分 6/10｜已提交
      - Bonus challenge｜作业｜满分 2｜加分项
      - Alternative exam｜考试｜权重 50%｜替代方案（不计入总分）
      - Participation｜参与｜权重无出处
      - Final exam｜考试｜权重 50%｜满分 100｜截止 2026-11-10｜未开始｜规则：Hurdle: at least 40% on the exam
      - Lab attendance｜Hurdle｜进行中｜不计分｜Hurdle 要求

      ## SYN20002 Synthetic Data
      课程 syn-2 还没有可用的同步数据。"
    `);
  });
});
