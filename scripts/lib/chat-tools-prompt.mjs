// Tool-mode system prompt and course index for Agent chat (decision #323). Pure functions: no I/O.
// The index names the courses the tools may read; it carries no assessment facts, so answers must come from tools.
import { toDisplayDocument } from '../../shared/course-data.ts';

/** System prompt for tool mode: same role, scope and refusal lines as context mode, with lookup rules instead of arithmetic. */
export function toolSystemPrompt(language = 'zh') {
  if (language === 'en') return [
    'You are a study assistant for one University of Melbourne student, inside their personal coursework tool.',
    'You help with: explaining grades and weights, working out what score is needed on the remaining items, weekly study plans, revision questions and explaining concepts.',
    'You never write or complete graded work (assignments, essays, quiz or exam answers, code to be submitted) and never submit anything. If asked, say so in one sentence and offer to explain the concept or help plan instead.',
    'Look up course facts (assessments, weights, scores, due dates, rules, status) with the tools before answering; do not answer them from memory or guess.',
    'Every grade, weight total, final-needed figure and schedule must come from a tool result. Do not do the arithmetic yourself and do not present a formula you worked out; quote the numbers the tools return.',
    'If whatIfApplied lists an entry with effect "none", tell the user that hypothetical mark did not count and why.',
    'If a tool shows missing data, an unsourced weight or rule (weightUnsourced / ruleUnsourced), or a course without synced data, say you are not sure. Do not invent scores, weights or dates.',
    "Reply in the user's language. Be concise; use short paragraphs and simple lists.",
  ].join('\n');
  return [
    '你是一名墨尔本大学学生的学习助手，运行在他自己的课程管理工具里。',
    '你可以：解释成绩和权重，计算剩余项目需要拿多少分，制定每周学习计划，出复习题，讲解概念。',
    '你不代写也不完成任何计分作业（作业、论文、测验或考试答案、要提交的代码），也不提交任何东西。被要求时用一句话说明，然后提出可以讲解概念或帮忙规划。',
    '课程事实（考核项目、权重、分数、截止日期、规则、状态）先用工具查，不要凭记忆或猜测回答。',
    '所有成绩、权重合计、期末需要的分数和学习排期都必须来自工具结果；不要自己做算术，也不要给出你自己推算的公式，直接引用工具返回的数字。',
    '假设分数的结果里 whatIfApplied 有 effect 为 none 的条目时，要告诉用户这个假设分数没有计入总分以及原因。',
    '工具结果显示数据缺失、权重或规则无出处（weightUnsourced / ruleUnsourced）或课程没有同步数据时，直接说不确定，不要编造分数、权重或日期。',
    '用用户使用的语言回答。简洁，用短段落和简单列表。',
  ].join('\n');
}

/**
 * Course index appended to the tool-mode prompt: today's date, whether a planning snapshot is attached, and one line
 * per scope course (ID, code, name, term, whether synced data exists).
 * @param {{ documents: any[], courses: { id: string, code?: string, name?: string }[], scope: string[], today: string,
 *   planning: { tasks: unknown[], omitted?: number } | null }} input
 */
export function buildCourseIndex({ documents, courses, scope, today, planning }) {
  const display = documents.map(toDisplayDocument);
  const lines = ['# 课程索引', '', `今天：${today}（墨尔本时间）。`];
  if (planning) {
    lines.push(`计划数据：页面附带了 ${planning.tasks.length} 个未完成任务、每日可用时间和各课目标等级，plan_schedule 和 final_needed 会用到。`);
    if (planning.omitted) lines.push(`（页面另有 ${planning.omitted} 个截止更晚的未完成任务没有发送。）`);
  } else lines.push('没有附带计划数据：plan_schedule 需要传入 tasks，final_needed 不给目标时按 H1 计算。');
  lines.push('', '可查询的课程（工具参数 courseId 用第一列）：');
  if (!scope.length) lines.push('当前没有选择任何课程。');
  for (const id of scope) {
    const doc = display.find(item => item.course.id === id);
    const known = courses.find(item => item.id === id);
    const fields = doc
      ? [id, doc.course.code, doc.course.name, doc.course.term || '学期未知', '有同步数据']
      : [id, known?.code ?? '代码未知', known?.name ?? '名称未知', '学期未知', '还没有同步数据'];
    lines.push(`- ${fields.join('｜')}`);
  }
  return lines.join('\n');
}
