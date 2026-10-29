// Contract v2 quote verification (openspec/changes/course-contract-v2/design.md §5). Runs after validation and repair on
// the built stored document: a weight or rule without a verified source is cleared and listed in `unsourced` (#247).
// Pure functions; no I/O.
import { DEFAULT_INSTITUTION } from '../institutions/registry.mjs';
import { indexCollected, normaliseText, renderGroupRules } from './course-refs.mjs';

export { normaliseText };

const MIN_QUOTE = 6, MAX_QUOTE = 500;
const list = value => (Array.isArray(value) ? value : []);
const twoDecimals = value => Math.round(value * 100);
const sameWeight = (a, b) => typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && twoDecimals(a) === twoDecimals(b);

/**
 * Normalised text units that describe assessments (decision #276): each framework table row (named by its component), each
 * other non-empty line of the framework text, each Ed context text, each Canvas group name and each group's rendered rule
 * text. The framework rows come from `framework` (the institution's framework source; none when null).
 * Canvas assignment names, Ed lesson titles, URLs and IDs are not included. Lines inside a table row are never units on
 * their own, so a row fragment cannot drop the component name. Returns `[{ text, name }]`; `name` is set for rows only.
 */
export function quoteCorpus({ canvas, ed, handbook } = {}, framework = DEFAULT_INSTITUTION.framework) {
  const units = [];
  const add = (value, name = null) => {
    const text = normaliseText(value);
    if (text) units.push({ text, name });
  };
  if (framework && handbook && typeof handbook === 'object' && handbook.status === 'available') {
    const text = String(handbook.text ?? '');
    const rows = framework.parseRows(text);
    const inRow = new Set(rows.flatMap(row => Array.from({ length: row.end - row.start + 1 }, (_, i) => row.start + i)));
    for (const row of rows) if (row.name) add(row.rowText, normaliseText(row.name));
    for (const [index, line] of text.split(/\r?\n/).entries()) if (!inRow.has(index)) add(line);
  }
  const edOk = ed && typeof ed === 'object' && !['unavailable', 'not_found'].includes(ed.status);
  if (edOk) for (const entry of list(ed.context)) if (typeof entry?.text === 'string') add(entry.text);
  const canvasOk = canvas && typeof canvas === 'object' && canvas.status !== 'unavailable';
  if (canvasOk) for (const group of list(canvas.groups)) {
    if (!group || typeof group !== 'object') continue;
    if (typeof group.name === 'string') add(group.name);
    add(renderGroupRules(group, canvas.assignments));
  }
  return units;
}

/** The units that contain the normalised quote, or none when the quote is missing, shorter than 6 or longer than 500 characters. */
export function quoteFound(corpus, quote) {
  if (typeof quote !== 'string') return [];
  const text = normaliseText(quote);
  if (text.length < MIN_QUOTE || text.length > MAX_QUOTE) return [];
  return corpus.filter(unit => unit.text.includes(text));
}

// A number token (not touching another digit or `.`) equal to the weight, followed by `%`, `per cent` or `percent`.
function statesWeight(text, weight) {
  for (const match of text.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*(?:%|per cent|percent)/g)) {
    if (sameWeight(Number(match[1]), weight)) return true;
  }
  return false;
}

// Check 3: the quote occurs in a unit, states the weight, and names the component when the unit is a framework row.
function weightQuotePasses(corpus, quote, weight) {
  const units = quoteFound(corpus, quote);
  if (!units.length) return false;
  const text = normaliseText(quote);
  if (!statesWeight(text, weight)) return false;
  return units.some(unit => unit.name === null || text.includes(unit.name));
}

// Checks 1 and 2: a cited Canvas group's weight or a cited framework component's percentage equals the weight.
function structuredWeight(index, refs, weight) {
  return list(refs).some(ref => {
    if (ref.platform === 'canvas-group') return sameWeight(index.groups.get(ref.id)?.group_weight, weight);
    if (ref.platform === 'handbook') return sameWeight(index.componentsByName.get(normaliseText(ref.id))?.percent, weight);
    return false;
  });
}

/**
 * Verifies every weight and rule of a stored v2 document against the collected data `{ canvas, ed, handbook }`. A weight is
 * sourced by a passing quote (kept), or by a cited Canvas group weight or framework percentage (quote set to null); a rule by
 * a passing quote. A failing field and its quote become null and the field is added to `unsourced`; a quote with a null
 * field is dropped. A `weighted` parent whose regular child no longer has a positive weight gets `scoring: 'none'`.
 * Returns `{ document, cleared }` (a new document; `cleared` counts the cleared fields).
 */
export function verifyQuotes(document, collected, framework = DEFAULT_INSTITUTION.framework) {
  const index = indexCollected(collected, framework);
  const corpus = quoteCorpus(collected, framework);
  let cleared = 0;
  const assessments = document.assessments.map(item => {
    const next = { ...item, unsourced: [...list(item.unsourced)] };
    const flag = field => {
      next[field] = null;
      next[`${field}Quote`] = null;
      if (!next.unsourced.includes(field)) next.unsourced.push(field);
      cleared++;
    };
    if (next.weight === null) next.weightQuote = null;
    else if (weightQuotePasses(corpus, next.weightQuote, next.weight)) { /* Verified quote kept. */ }
    else if (structuredWeight(index, next.refs, next.weight)) next.weightQuote = null;
    else flag('weight');
    if (next.rule === null) next.ruleQuote = null;
    else if (!quoteFound(corpus, next.ruleQuote).length) flag('rule');
    return next;
  });
  for (const parent of assessments) {
    if (parent.scoring !== 'weighted') continue;
    const children = assessments.filter(child => child.parentId === parent.id && child.nature === 'regular');
    if (children.some(child => child.weight === null || child.weight <= 0)) parent.scoring = 'none';
  }
  return { document: { ...document, assessments }, cleared };
}
