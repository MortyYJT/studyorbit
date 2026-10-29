// Course context and system prompt for Agent chat (decision #230). Pure functions: no I/O.
// Totals reuse the same grade calculation as the course page, applied to the synced document only
// (owner corrections made in the browser are not visible here).
import { calculateGrades } from '../../shared/course-calculations.ts';
import { toDisplayDocument } from '../../shared/course-data.ts';
import { gradingInputs } from '../../shared/course-tools.ts';
import { toolSystemPrompt } from './chat-tools-prompt.mjs';

export const CONTEXT_LIMIT = 24000;
const TRUNCATION_NOTE = '\n（课程数据过长，已截断，后面的内容没有提供给你。）';

const KIND = { quiz: '测验', assignment: '作业', test: '考试', presentation: '展示', participation: '参与', hurdle: 'Hurdle', other: '其他' };
const STATUS = { not_started: '未开始', in_progress: '进行中', submitted: '已提交', graded: '已出分' };
const SCORING = { points: '按子项原始分合计', weighted: '按子项权重加权' };

const round = value => Number(value.toFixed(2));

function formatDue(due) {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return due;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function describe(item) {
  const fields = [item.name, KIND[item.kind] ?? item.kind];
  if (item.weight !== null) fields.push(`权重 ${round(item.weight)}%`);
  if (item.score !== null || item.maxScore !== null) fields.push(item.score !== null ? `得分 ${round(item.score)}/${item.maxScore === null ? '?' : round(item.maxScore)}` : `满分 ${round(item.maxScore)}`);
  const due = formatDue(item.due);
  if (due) fields.push(`截止 ${due}`);
  if (STATUS[item.status]) fields.push(STATUS[item.status]);
  if (item.nature === 'bonus') fields.push('加分项');
  if (item.nature === 'ungraded') fields.push('不计分');
  if (item.nature === 'alternative') fields.push('替代方案（不计入总分）');
  if (item.kind === 'hurdle') fields.push('Hurdle 要求');
  if (SCORING[item.scoring]) fields.push(`计分：${SCORING[item.scoring]}`);
  if (item.rule) fields.push(`规则：${item.rule.replace(/\s+/g, ' ').trim()}`);
  return fields.join('｜');
}

/** Totals from the same grading inputs as the course page and the course tools, built from an uncorrected document. */
function totals(doc) {
  const { assessments, parents } = gradingInputs(doc);
  return calculateGrades(assessments, parents);
}

function courseBlock(doc) {
  const { course } = doc;
  const lines = [`## ${course.code} ${course.name}${course.term ? `（${course.term}）` : ''}`];
  const { weight, earned, average } = totals(doc);
  lines.push(weight > 0
    ? `已出分权重 ${round(weight)}%，已得 ${round(earned)} 分（总分 100），已出分部分平均 ${round(average)}%。`
    : '还没有可计算的已出分项目。');
  if (!doc.assessments.length) lines.push('（没有记录到评估项目。）');
  for (const item of doc.assessments.filter(entry => entry.parentId === null)) {
    lines.push(`- ${describe(item)}`);
    for (const child of doc.assessments.filter(entry => entry.parentId === item.id)) lines.push(`  - ${describe(child)}`);
  }
  return lines;
}

/**
 * Compact Chinese description of the selected courses for the chat system prompt, capped at CONTEXT_LIMIT characters.
 * @param {(import('../../shared/course-data.ts').CourseDocument | import('../../shared/course-data.ts').DisplayDocument)[]} documents
 *   synced course documents of either version; each is read through `toDisplayDocument`
 * @param {{ today: string, courseIds?: string[], courses?: { id: string, code?: string, name?: string }[] }} options
 *   courseIds limits the scope (undefined = every document); courses names selected courses that have no document.
 */
export function buildChatContext(stored, { today, courseIds, courses = [] }) {
  const documents = stored.map(toDisplayDocument);
  const scope = courseIds ?? documents.map(doc => doc.course.id);
  const lines = [`今天：${today}（墨尔本时间）。`, '以下是同步得到的课程数据，不包含用户在页面上做的修改。分数是原始得分/满分，权重是占课程总分的百分比。', ''];
  if (!scope.length) lines.push('当前没有选择任何课程。');
  for (const id of scope) {
    const doc = documents.find(item => item.course.id === id);
    if (doc) { lines.push(...courseBlock(doc), ''); continue; }
    const known = courses.find(item => item.id === id);
    lines.push(`## ${known?.code ?? id}${known?.name ? ` ${known.name}` : ''}`, `课程 ${id} 还没有可用的同步数据。`, '');
  }
  let text = lines.join('\n').trimEnd();
  if (text.length <= CONTEXT_LIMIT) return text;
  text = text.slice(0, CONTEXT_LIMIT - TRUNCATION_NOTE.length);
  const lastBreak = text.lastIndexOf('\n');
  return `${lastBreak > 0 ? text.slice(0, lastBreak) : text}${TRUNCATION_NOTE}`;
}

/** System prompt for the study assistant. Context mode appends the course context; tool mode the course index. */
export function chatSystemPrompt(language = 'zh', mode = 'context') {
  if (mode === 'tools') return toolSystemPrompt(language);
  if (language === 'en') return [
    'You are a study assistant for one University of Melbourne student, inside their personal coursework tool.',
    'You help with: explaining grades and weights, working out what score is needed on the remaining items, weekly study plans, revision questions and explaining concepts.',
    'You never write or complete graded work (assignments, essays, quiz or exam answers, code to be submitted) and never submit anything. If asked, say so in one sentence and offer to explain the concept or help plan instead.',
    'Answer from the course data below. If the data is missing or unclear, say you are not sure. Do not invent scores, weights or dates; show the arithmetic when you calculate.',
    "Reply in the user's language. Be concise; use short paragraphs and simple lists.",
  ].join('\n');
  return [
    '你是一名墨尔本大学学生的学习助手，运行在他自己的课程管理工具里。',
    '你可以：解释成绩和权重，计算剩余项目需要拿多少分，制定每周学习计划，出复习题，讲解概念。',
    '你不代写也不完成任何计分作业（作业、论文、测验或考试答案、要提交的代码），也不提交任何东西。被要求时用一句话说明，然后提出可以讲解概念或帮忙规划。',
    '只根据下面的课程数据回答。数据缺失或不清楚时直接说不确定，不要编造分数、权重或日期；计算时写出算式。',
    '用用户使用的语言回答。简洁，用短段落和简单列表。',
  ].join('\n');
}
