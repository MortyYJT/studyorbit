// Pure scoring for the course-analysis evaluation harness (docs/eval-format.md).
// Compares validated model documents with a gold course document; no I/O.
import { platformIdentities, slug } from './course-refs.mjs';

/** Assessment fields compared against the gold document, in report order. */
export const SCORED_FIELDS = ['kind', 'nature', 'parentId', 'weight', 'maxScore', 'score', 'due', 'scoring', 'status'];
export const MISSING = '<missing>';
const TOLERANCE = 1e-6;

/** Lowercase, turn punctuation and symbols into spaces, collapse whitespace. */
export function normaliseName(name) {
  return String(name ?? '').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Drop the `assessments.N.` / `assessments.N: ` index prefix so the same issue groups across items. */
export function normaliseIssue(message) {
  return String(message).replace(/^assessments\.\d+(?:\.|:\s*)/, '');
}

function dateOnly(value) {
  return typeof value === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? value : null;
}

function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= TOLERANCE;
  return a === b;
}

/**
 * Pair each gold assessment with at most one predicted assessment (course-contract-v2 design §7): same id first; then a
 * shared Canvas assignment or Ed lesson (v2 `refs`, v1 source URLs or platform-shaped ids, a bare-number gold id tried as
 * Canvas then Ed); then the same name slug. Each pass takes the first unused predicted item.
 * Returns one `{ gold, predicted }` entry per gold item, in gold order.
 */
export function matchAssessments(goldItems, predictedItems) {
  const used = new Set();
  const pairs = goldItems.map(gold => {
    const index = predictedItems.findIndex((item, i) => !used.has(i) && item.id === gold.id);
    if (index >= 0) used.add(index);
    return { gold, predicted: index >= 0 ? predictedItems[index] : null };
  });
  // Predicted identities are concrete only: a bare-number predicted id is matched by the id pass.
  const known = predictedItems.map(item => new Set(platformIdentities(item).flatMap(identity => ('bare' in identity ? [] : [`${identity.platform}:${identity.id}`]))));
  const take = index => { used.add(index); return predictedItems[index]; };
  for (const pair of pairs) {
    if (pair.predicted) continue;
    for (const identity of platformIdentities(pair.gold)) {
      const wanted = 'bare' in identity ? [`canvas:${identity.bare}`, `ed:${identity.bare}`] : [`${identity.platform}:${identity.id}`];
      const index = wanted.map(key => known.findIndex((set, i) => !used.has(i) && set.has(key))).find(i => i >= 0);
      if (index !== undefined) { pair.predicted = take(index); break; }
    }
  }
  for (const pair of pairs) {
    if (pair.predicted) continue;
    const name = slug(pair.gold.name);
    const index = predictedItems.findIndex((item, i) => !used.has(i) && slug(item.name) === name);
    if (index >= 0) pair.predicted = take(index);
  }
  return pairs;
}

// Value of one field in gold terms. A predicted parent is translated to the gold id it was matched to.
function fieldValue(field, item, toGold) {
  if (field === 'due') return dateOnly(item.due);
  if (field === 'parentId') {
    if (item.parentId === null || item.parentId === undefined) return null;
    return toGold ? toGold.get(item.parentId) ?? `<unmatched:${item.parentId}>` : item.parentId;
  }
  return item[field] ?? null;
}

/** One value per (gold assessment, field) cell for a predicted document; unmatched cells are `<missing>`. */
function cellValues(gold, predicted) {
  const pairs = matchAssessments(gold.assessments, predicted.assessments);
  const toGold = new Map(pairs.filter(pair => pair.predicted).map(pair => [pair.predicted.id, pair.gold.id]));
  return {
    pairs,
    cells: pairs.flatMap(({ gold: goldItem, predicted: item }) => SCORED_FIELDS.map(field => ({
      goldId: goldItem.id, field,
      expected: fieldValue(field, goldItem, null),
      actual: item ? fieldValue(field, item, toGold) : MISSING,
    }))),
  };
}

/** Field accuracy, per-field counts, recall and precision of one predicted document against the gold one. */
export function scoreDocument(gold, predicted) {
  const { pairs, cells } = cellValues(gold, predicted);
  const perField = Object.fromEntries(SCORED_FIELDS.map(field => [field, { correct: 0, total: 0 }]));
  const mismatches = [];
  for (const cell of cells) {
    const ok = sameValue(cell.expected, cell.actual);
    perField[cell.field].total++;
    if (ok) perField[cell.field].correct++;
    else if (cell.actual !== MISSING) mismatches.push(cell);
  }
  const matched = pairs.filter(pair => pair.predicted);
  const matchedIds = new Set(matched.map(pair => pair.predicted));
  const correct = cells.filter(cell => sameValue(cell.expected, cell.actual)).length;
  return {
    correct, cells: cells.length,
    fieldAccuracy: cells.length ? correct / cells.length : null,
    perField,
    goldCount: gold.assessments.length, predictedCount: predicted.assessments.length, matched: matched.length,
    recall: gold.assessments.length ? matched.length / gold.assessments.length : null,
    precision: predicted.assessments.length ? matched.length / predicted.assessments.length : null,
    unmatchedGold: pairs.filter(pair => !pair.predicted).map(pair => pair.gold.id),
    extraPredicted: predicted.assessments.filter(item => !matchedIds.has(item)).map(item => item.id),
    mismatches,
  };
}

/** Order-independent form of a document: ids, normalised names and scored fields only (free text dropped). */
export function normaliseDocument(document) {
  return document.assessments.map(item => ({
    id: item.id, name: normaliseName(item.name),
    ...Object.fromEntries(SCORED_FIELDS.map(field => [field, fieldValue(field, item, null)])),
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Rerun consistency over runs (`null` = the run produced no document). A cell agrees when every document gives
 * the same value. `identicalToFirst` = runs whose normalised document equals the first document / all runs.
 */
export function consistency(gold, documents) {
  const present = documents.filter(Boolean);
  if (!present.length) return { documentRuns: 0, cells: 0, agreeingCells: 0, cellAgreement: null, identicalRuns: 0, identicalToFirst: null };
  const tables = present.map(document => cellValues(gold, document).cells);
  const agreeingCells = tables[0].filter((cell, index) => tables.every(table => sameValue(table[index].actual, cell.actual))).length;
  const reference = JSON.stringify(normaliseDocument(present[0]));
  const identicalRuns = documents.filter(document => document && JSON.stringify(normaliseDocument(document)) === reference).length;
  return {
    documentRuns: present.length, cells: tables[0].length, agreeingCells,
    cellAgreement: tables[0].length ? agreeingCells / tables[0].length : null,
    identicalRuns, identicalToFirst: identicalRuns / documents.length,
  };
}

/**
 * Validation interception over runs. `failed` = the model call or process failed, threw or was cancelled
 * (`run.failed`); `rejected` = the model answered but the output was still invalid after the repair.
 * Issues are tallied only from attempts whose model call succeeded (an attempt without `exitCode` counts as succeeded).
 */
export function interceptionCounts(runs) {
  const issues = {};
  for (const run of runs) for (const attempt of run.attempts) {
    if ('exitCode' in attempt && attempt.exitCode !== 0) continue;
    for (const issue of attempt.issues ?? []) {
      const key = normaliseIssue(issue);
      issues[key] = (issues[key] ?? 0) + 1;
    }
  }
  return {
    runs: runs.length,
    repairTriggered: runs.filter(run => run.attempts.length > 1).length,
    rejected: runs.filter(run => !run.accepted && !run.failed).length,
    failed: runs.filter(run => !run.accepted && run.failed).length,
    issues,
  };
}

const ratio = (a, b) => (b ? a / b : null);

/** Weights and rules a stored v2 document cleared as unsourced (「无出处」); v1 items without `unsourced` count none. */
export function unsourcedCounts(document) {
  const fields = document.assessments.flatMap(item => (Array.isArray(item.unsourced) ? item.unsourced : []));
  return { weight: fields.filter(field => field === 'weight').length, rule: fields.filter(field => field === 'rule').length };
}

/**
 * Summary for one course over its runs. Each run: `{ accepted, failed?, document, attempts, durationMs, usage }`.
 * Accuracy, recall and precision are pooled over runs that produced a document.
 */
export function summariseCourse(gold, runs) {
  const scores = runs.filter(run => run.document).map(run => scoreDocument(gold, run.document));
  const sum = key => scores.reduce((total, score) => total + score[key], 0);
  const perFieldCounts = Object.fromEntries(SCORED_FIELDS.map(field => [field, {
    correct: scores.reduce((total, score) => total + score.perField[field].correct, 0),
    total: scores.reduce((total, score) => total + score.perField[field].total, 0),
  }]));
  const withUsage = runs.filter(run => run.usage);
  const totalMs = runs.reduce((total, run) => total + (run.durationMs ?? 0), 0);
  const counts = {
    correct: sum('correct'), cells: sum('cells'), matched: sum('matched'), gold: sum('goldCount'), predicted: sum('predictedCount'),
  };
  const agreement = consistency(gold, runs.map(run => run.document ?? null));
  const unsourcedPerRun = runs.map(run => (run.document ? unsourcedCounts(run.document) : null));
  return {
    runs: runs.length, documentRuns: scores.length,
    fieldAccuracy: ratio(counts.correct, counts.cells),
    perField: Object.fromEntries(Object.entries(perFieldCounts).map(([field, value]) => [field, ratio(value.correct, value.total)])),
    recall: ratio(counts.matched, counts.gold),
    precision: ratio(counts.matched, counts.predicted),
    cellAgreement: agreement.cellAgreement,
    identicalToFirst: agreement.identicalToFirst,
    interception: interceptionCounts(runs),
    unsourced: {
      weight: unsourcedPerRun.reduce((total, counts) => total + (counts?.weight ?? 0), 0),
      rule: unsourcedPerRun.reduce((total, counts) => total + (counts?.rule ?? 0), 0),
      perRun: unsourcedPerRun,
    },
    tokens: {
      input: withUsage.reduce((total, run) => total + (run.usage.input ?? 0), 0),
      output: withUsage.reduce((total, run) => total + (run.usage.output ?? 0), 0),
      runsWithUsage: withUsage.length,
    },
    durationMs: { total: totalMs, mean: runs.length ? totalMs / runs.length : null },
    counts: { ...counts, perField: perFieldCounts, agreeingCells: agreement.agreeingCells, consistencyCells: agreement.cells, identicalRuns: agreement.identicalRuns },
    mismatches: scores.map(score => ({ unmatchedGold: score.unmatchedGold, extraPredicted: score.extraPredicted, mismatches: score.mismatches })),
  };
}

/** Pool course summaries: every ratio is recomputed from the summed counts, not averaged. */
export function summariseOverall(summaries) {
  const sum = pick => summaries.reduce((total, summary) => total + pick(summary), 0);
  const issues = {};
  for (const summary of summaries) for (const [key, count] of Object.entries(summary.interception.issues)) issues[key] = (issues[key] ?? 0) + count;
  const runs = sum(s => s.runs);
  return {
    courses: summaries.length, runs, documentRuns: sum(s => s.documentRuns),
    fieldAccuracy: ratio(sum(s => s.counts.correct), sum(s => s.counts.cells)),
    perField: Object.fromEntries(SCORED_FIELDS.map(field => [field, ratio(sum(s => s.counts.perField[field].correct), sum(s => s.counts.perField[field].total))])),
    recall: ratio(sum(s => s.counts.matched), sum(s => s.counts.gold)),
    precision: ratio(sum(s => s.counts.matched), sum(s => s.counts.predicted)),
    cellAgreement: ratio(sum(s => s.counts.agreeingCells), sum(s => s.counts.consistencyCells)),
    identicalToFirst: ratio(sum(s => s.counts.identicalRuns), runs),
    interception: { runs, repairTriggered: sum(s => s.interception.repairTriggered), rejected: sum(s => s.interception.rejected), failed: sum(s => s.interception.failed), issues },
    unsourced: { weight: sum(s => s.unsourced.weight), rule: sum(s => s.unsourced.rule) },
    tokens: { input: sum(s => s.tokens.input), output: sum(s => s.tokens.output), runsWithUsage: sum(s => s.tokens.runsWithUsage) },
    durationMs: { total: sum(s => s.durationMs.total), mean: runs ? sum(s => s.durationMs.total) / runs : null },
  };
}
