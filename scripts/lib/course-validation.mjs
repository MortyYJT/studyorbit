import { CourseModelOutputSchema } from '../../shared/course-data.ts';
import { verifyQuotes } from './course-quotes.mjs';
import { buildStoredDocument, canonicalRefs, generateIds, indexCollected, resolveRef } from './course-refs.mjs';
import { DEFAULT_INSTITUTION } from '../institutions/registry.mjs';
import { resolveSources } from '../sources/registry.mjs';

/** The sources of the default institution, for callers that settle its recorded data (tests, the evaluation). */
const DEFAULT_SOURCES = resolveSources(null, DEFAULT_INSTITUTION);

const REPORT_STATUSES = ['completed', 'partial', 'failed'];
const PLATFORM_LABELS = { canvas: 'Canvas 作业 ID', 'canvas-group': 'Canvas 作业分组 ID', ed: 'Ed lesson ID' };

// Checks one model output (contract v2): JSON shape, the model output schema, references against the collected data,
// keys and parents, semantic rules the schema cannot express, generated IDs, and that the document belongs to `course`.
// `framework` is the institution's framework source (default the default institution's; null when it has none). Also
// returns the framework components parsed from the collected framework text. When the institution has a framework
// source but none of its components are available (not collected or not parsable), a leaf without references is
// allowed (decision #482): an exam the framework would have listed has nothing else to cite.
export function validateAnalysis(raw, { course, canvas, ed, handbook, framework = DEFAULT_INSTITUTION.framework }) {
  let report;
  try { report = JSON.parse(raw); } catch { report = null; }
  const index = indexCollected({ canvas, ed, handbook }, framework);
  const parsed = CourseModelOutputSchema.safeParse(report?.document);
  const issues = parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
  const allowUnreferenced = unreferencedLeavesAllowed(index, framework);
  if (parsed.success) issues.push(...referenceIssues(parsed.data, index, framework), ...structureIssues(parsed.data, allowUnreferenced));
  if (parsed.success && !issues.length) issues.push(...idIssues(parsed.data, index));
  const valid = Boolean(report) && typeof report.reason === 'string' && REPORT_STATUSES.includes(report.status)
    && (report.status === 'failed' ? report.document === null
      : parsed.success && issues.length === 0 && parsed.data.course.id === course.id && parsed.data.course.code === course.subjectCode);
  if (!valid && !issues.length) issues.push('结果格式或课程身份不匹配');
  return { report, parsed, issues, valid, components: index.components };
}

/** Whether a leaf may have no references: the institution has a framework source and no component of it is available. */
export function unreferencedLeavesAllowed(index, framework) {
  return Boolean(framework) && index.components.length === 0;
}

/** Leaves (items without children) that have no references. */
export function unreferencedLeaves(assessments) {
  const parents = new Set(assessments.map(item => item.parentKey).filter(key => key !== null));
  return assessments.filter(item => !item.refs.length && !parents.has(item.key));
}

// Every reference must exist in the collected data; a Canvas assignment or Ed lesson belongs to one item only. A
// `handbook` reference without a framework source names a source that was not collected.
function referenceIssues(document, index, framework) {
  const issues = [];
  const owners = new Map();
  for (const [itemIndex, item] of document.assessments.entries()) {
    for (const [refIndex, ref] of item.refs.entries()) {
      const where = `assessments.${itemIndex}.refs.${refIndex}: 「${item.name}」引用的 ${ref.platform} ${ref.id}`;
      if (!resolveRef(index, ref)) {
        issues.push(`${where} ${ref.platform !== 'handbook' ? `不是采集到的 ${PLATFORM_LABELS[ref.platform]}`
          : framework ? `不是 ${framework.label} 考核表中列出的考核项名称` : '所属的来源没有采集，不能引用'}`);
        continue;
      }
      if (ref.platform !== 'canvas' && ref.platform !== 'ed') continue;
      const key = `${ref.platform}\u0000${ref.id}`;
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, itemIndex);
      else if (owner !== itemIndex) issues.push(`${where} 已被 assessments.${owner} 引用，同一作业只能属于一个考核项`);
    }
  }
  return issues;
}

// Keys are unique; parents exist, are acyclic and one level deep; a leaf needs a reference (unless `allowUnreferenced`);
// scoring rules on parents.
function structureIssues(document, allowUnreferenced = false) {
  const issues = [];
  const items = document.assessments;
  const byKey = new Map();
  for (const [index, item] of items.entries()) {
    if (byKey.has(item.key)) issues.push(`assessments.${index}.key: key ${item.key} 重复`);
    else byKey.set(item.key, item);
  }
  for (const [index, item] of items.entries()) {
    const visited = new Set([item.key]);
    let parent = item.parentKey, broken = false;
    while (parent !== null) {
      if (!byKey.has(parent) || visited.has(parent)) { broken = true; break; }
      visited.add(parent); parent = byKey.get(parent).parentKey;
    }
    if (broken) issues.push(`assessments.${index}.parentKey: parentKey 指向的考核项不存在或成环`);
    else if (item.parentKey !== null && byKey.get(item.parentKey).parentKey !== null) issues.push(`assessments.${index}.parentKey: 只支持一层父子`);
    const children = items.filter(child => child.parentKey === item.key && child !== item);
    if (!item.refs.length && !children.length && !allowUnreferenced) issues.push(`assessments.${index}.refs: 「${item.name}」没有任何引用，也没有子项`);
    const scoringChildren = children.filter(child => child.nature === 'regular');
    if (item.scoring !== 'none' && (item.parentKey !== null || scoringChildren.length === 0)) issues.push(`assessments.${index}.scoring: 只有有计分子项的顶层父项可使用 points 或 weighted`);
    if (item.scoring === 'weighted' && scoringChildren.some(child => child.weight === null || child.weight <= 0)) issues.push(`assessments.${index}.scoring: weighted 要求每个计分子项有明确正权重`);
  }
  return issues;
}

// Generated IDs (from canonical references) must be unique and fit the stored schema.
function idIssues(document, index) {
  const issues = [];
  const { ids } = generateIds(document.assessments.map(item => ({ ...item, refs: canonicalRefs(index, item.refs) })));
  const first = new Map();
  for (const [itemIndex, id] of ids.entries()) {
    if (id.length > 500) { issues.push(`assessments.${itemIndex}: 生成的 ID 超过 500 个字符，请缩短名称`); continue; }
    if (first.has(id)) issues.push(`assessments.${itemIndex}: 生成的 ID ${id} 与 assessments.${first.get(id)} 重复，请给这些考核项不同的名称`);
    else first.set(id, itemIndex);
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
// `sources` are the job's sources in collection order (default the default institution's) and `collection` their flags `{ [id]: { failed, partial,
// unpaginated } }` (a source missing from `collection` counts as collected). `data` is the collected data by source id
// and `previous` the newest valid earlier document (or null); an accepted document is saved as the stored v2 document
// built from them, after quote verification (design §5): fields without a verified source are cleared and counted in
// the reason as 「N 项权重或规则无出处」, without changing the status. A framework source that was collected but has no
// parsable assessment table also makes the course at most partial. The reason names each source by its label.
export function settleCourse({ result, validation, collection, sources = DEFAULT_SOURCES, data, previous = null, framework = DEFAULT_INSTITUTION.framework }) {
  const { report, parsed, issues } = validation;
  if (result.exitCode === 0 && validation.valid) {
    let status = report.status;
    let reason = report.reason.slice(0, 500);
    const notes = collectionNotes({ sources, collection, data, framework, components: validation.components });
    // A leaf without references (allowed only without framework components) keeps the course at most partial.
    const unreferenced = parsed.success ? unreferencedLeaves(parsed.data.assessments).length : 0;
    const allNotes = `${notes}${unreferenced ? `${unreferenced} 项考核没有来源引用；` : ''}`;
    if (allNotes) {
      if (status === 'completed') status = 'partial';
      reason = `${allNotes}${reason}`;
    }
    let document = null;
    if (report.status !== 'failed' && parsed.success) {
      const verified = verifyQuotes(buildStoredDocument(parsed.data, data, previous, framework), data, framework);
      document = verified.document;
      if (verified.cleared) reason = `${reason}${reason && !/[；。]$/.test(reason) ? '；' : ''}${verified.cleared} 项权重或规则无出处`;
    }
    return {
      accepted: true, status, reason, document,
      diagnostic: report.status === 'failed' ? { raw: result.lastMessage, issues: [] } : null,
    };
  }
  // A rejected reply names the sources that could not be read first: their absence is usually why it was rejected.
  const notes = result.exitCode !== 0 ? '' : collectionNotes({ sources, collection, data, framework, components: validation.components ?? [] });
  return {
    accepted: false, status: 'failed', document: null,
    diagnostic: { raw: result.lastMessage, issues },
    reason: result.exitCode !== 0 ? result.error || '模型任务未正常完成，请检查模型配置及连接。'
      : `${notes}${issues.length ? `课程数据校验失败：${issues.slice(0, 3).join('；')}` : '课程结果缺失或课程身份不匹配。'}`,
  };
}

/**
 * The collection notes of a course, one per source in order: not read (with the cause a failed collector left in its
 * placeholder, decision #481), pagination not verified, partly read, or a framework table that could not be parsed.
 */
function collectionNotes({ sources, collection, data, framework, components }) {
  return sources.map(source => {
    const flags = collection[source.id] ?? {};
    if (flags.failed) {
      const cause = data?.[source.id]?.reason;
      const detail = typeof cause === 'string' && cause && cause !== `${source.label} 采集不可用` ? `（${cause.slice(0, 300)}）` : '';
      return `${source.label} 数据未能读取${detail}；`;
    }
    if (flags.unpaginated) return `${source.label} 分页未验证；`;
    if (flags.partial) return `部分 ${source.label} 数据未能读取；`;
    if (framework && source.id === framework.id && data?.[source.id]?.status === 'available' && components.length === 0) return `${source.label} 考核表未能解析；`;
    return '';
  }).join('');
}
