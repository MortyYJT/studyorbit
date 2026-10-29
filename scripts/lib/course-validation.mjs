import { CourseDocumentV1Schema } from '../../shared/course-data.ts';

const REPORT_STATUSES = ['completed', 'partial', 'failed'];

// Checks one model output: JSON shape, the course document schema, semantic
// rules the schema cannot express, and that the document belongs to `course`.
export function validateAnalysis(raw, { course, canvas, ed }) {
  let report;
  try { report = JSON.parse(raw); } catch { report = null; }
  const parsed = CourseDocumentV1Schema.safeParse(report?.document);
  const issues = parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
  if (parsed.success) issues.push(...semanticIssues(parsed.data, canvas, ed));
  const valid = Boolean(report) && typeof report.reason === 'string' && REPORT_STATUSES.includes(report.status)
    && (report.status === 'failed' ? report.document === null
      : parsed.success && issues.length === 0 && parsed.data.course.id === course.id && parsed.data.course.code === course.subjectCode);
  if (!valid && !issues.length) issues.push('结果格式或课程身份不匹配');
  return { report, parsed, issues, valid };
}

function semanticIssues(document, canvasData, edData) {
  const issues = [];
  const items = document.assessments;
  for (const [index, item] of items.entries()) {
    const children = items.filter(child => child.parentId === item.id && child.nature === 'regular');
    if (item.scoring !== 'none' && (item.parentId !== null || children.length === 0)) issues.push(`assessments.${index}.scoring: 只有有计分子项的顶层父项可使用 points 或 weighted`);
    if (item.scoring === 'weighted' && children.some(child => child.weight === null || child.weight <= 0)) issues.push(`assessments.${index}.scoring: weighted 要求每个计分子项有明确正权重`);
    if (!children.length && item.score !== null && item.maxScore !== null) {
      // An Ed score must keep its own maximum unless Canvas confirms the same pair.
      const lessons = Array.isArray(edData?.lessons) ? edData.lessons : [];
      const scores = Array.isArray(edData?.scores) ? edData.scores : [];
      const matched = lessons.filter(lesson => item.sources.some(source => source.platform === 'ed' && source.url === lesson.url))
        .flatMap(lesson => scores.filter(score => String(score.lessonId) === String(lesson.id) && score.status === 'graded'));
      const canvasMatches = (Array.isArray(canvasData?.assignments) ? canvasData.assignments : []).some(assignment =>
        item.sources.some(source => source.platform === 'canvas' && source.url === assignment.html_url)
        && assignment.submission?.score === item.score && assignment.points_possible === item.maxScore);
      if (matched.length === 1 && matched[0].score === item.score && matched[0].maxScore !== item.maxScore && !canvasMatches)
        issues.push(`assessments.${index}: Ed 已得 ${matched[0].score}/${matched[0].maxScore}，请使用同一来源的得分和满分`);
    }
  }
  return issues;
}

export function repairPrompt(issues, lastMessage) {
  return `\n上次输出未通过校验，请只修复并完整返回符合 Schema 的 JSON。错误：${JSON.stringify(issues)}\n上次输出：${lastMessage}`;
}

// Sums usage across attempts; a key is null when any attempt lacks it.
export function combineUsage(attempts) {
  if (!attempts.every(item => item.usage)) return null;
  return Object.fromEntries(['input', 'cached', 'output', 'reasoning'].map(key =>
    [key, attempts.every(item => Number.isSafeInteger(item.usage[key])) ? attempts.reduce((sum, item) => sum + item.usage[key], 0) : null]));
}

// Calls the model, and once more with the issues when the output is invalid.
// `run(prompt)` resolves to { exitCode, lastMessage, usage, error?, threadId? }.
export async function analyseWithRepair({ instructions, run, validate, isCancelled }) {
  let result, validation;
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const repair = attempt ? repairPrompt(result.issues, result.lastMessage) : '';
    result = await run(instructions + repair);
    validation = validate(result.lastMessage);
    result.issues = validation.issues;
    attempts.push({ exitCode: result.exitCode, raw: result.lastMessage, issues: result.issues, usage: result.usage });
    if (result.exitCode !== 0 || isCancelled() || validation.valid) break;
  }
  if (attempts.length > 1) result.usage = combineUsage(attempts);
  return { result, validation, attempts };
}

// Decides what to save after analysis. Rejected output is never saved; its raw
// text and issues are returned as a diagnostic for `.local/lms/sync-errors/`.
// `collection` flags: canvasFailed, canvasUnpaginated, edFailed, edPartial, handbookFailed.
export function settleCourse({ result, validation, collection }) {
  const { report, parsed, issues } = validation;
  if (result.exitCode === 0 && validation.valid) {
    let status = report.status;
    let reason = report.reason.slice(0, 500);
    const { canvasFailed, canvasUnpaginated, edFailed, edPartial, handbookFailed } = collection;
    if (canvasFailed || canvasUnpaginated || edFailed || edPartial || handbookFailed) {
      if (status === 'completed') status = 'partial';
      reason = `${canvasFailed ? 'Canvas 数据未能读取；' : canvasUnpaginated ? 'Canvas 分页未验证；' : ''}${edFailed ? 'Ed 数据未能读取；' : edPartial ? '部分 Ed 数据未能读取；' : ''}${handbookFailed ? 'Handbook 数据未能读取；' : ''}${reason}`;
    }
    return {
      accepted: true, status, reason,
      document: report.status !== 'failed' && parsed.success ? parsed.data : null,
      diagnostic: report.status === 'failed' ? { raw: result.lastMessage, issues: [] } : null,
    };
  }
  return {
    accepted: false, status: 'failed', document: null,
    diagnostic: { raw: result.lastMessage, issues },
    reason: result.exitCode !== 0 ? result.error || '模型任务未正常完成，请检查模型配置及连接。'
      : issues.length ? `课程数据校验失败：${issues.slice(0, 3).join('；')}` : '课程结果缺失或课程身份不匹配。',
  };
}
