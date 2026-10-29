// Parsing of the UniMelb Handbook assessment page (the `unimelb` framework source; openspec change generic-adapters,
// design §4), moved unchanged from scripts/lib/course-refs.mjs (contract v2, course-contract-v2 design §2).
import { normaliseText } from '../../lib/course-refs.mjs';

const PERCENT_CELL = /^(\d+(?:\.\d+)?)\s*%$/;
const NO_PERCENT_CELLS = new Set(['n/a', 'nil', '-', '—']);

/**
 * Rows of the Handbook assessment table (design §2): tab-separated cells ending in a percentage or N/A-like cell. A row
 * starts after the previous row end or the `Percentage` header line, whichever is later, so multi-line description cells
 * stay together. Returns `[{ name, percent, rowText, start, end }]` in page order, where `start`..`end` are the row's line
 * indexes (inclusive) and `name` is the first line of the first cell ('' when empty). Used for components and the quote corpus.
 */
export function parseHandbookRows(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  let start = null;
  for (const [index, line] of lines.entries()) {
    if (!line.includes('\t')) continue;
    const cells = line.split('\t').map(cell => cell.trim());
    if (cells.some(cell => cell.toLowerCase() === 'percentage')) { start = index + 1; continue; }
    const last = cells.at(-1);
    const percentMatch = PERCENT_CELL.exec(last);
    if (!percentMatch && !NO_PERCENT_CELLS.has(last.toLowerCase())) continue;
    const rowStart = start ?? index;
    const row = lines.slice(rowStart, index + 1).join('\n');
    start = index + 1;
    const firstCell = row.slice(0, row.indexOf('\t'));
    const name = (firstCell.split('\n').map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '').slice(0, 200);
    rows.push({ name, percent: percentMatch ? Number(percentMatch[1]) : null, rowText: row.replace(/\s*[\t\n]+\s*/g, ' ').trim(), start: rowStart, end: index });
  }
  return rows;
}

/**
 * Assessment components parsed from the Handbook page text (design §2): rows of tab-separated cells ending in a
 * percentage or N/A-like cell, named by the first line of the first cell. Equal name and percentage rows are merged
 * (the table may repeat per study period); a repeated name with another percentage gets ` (2)`, ` (3)` in page order.
 * Rows with an empty name are skipped. Returns `[{ name, percent, rowTexts }]`.
 */
export function parseHandbookComponents(text) {
  const components = [];
  const byKey = new Map(), nameCounts = new Map();
  for (const { name, percent, rowText } of parseHandbookRows(text)) {
    if (!name) continue;
    const normalised = normaliseText(name);
    const key = `${normalised}\u0000${percent}`;
    const existing = byKey.get(key);
    if (existing) { existing.rowTexts.push(rowText); continue; }
    const count = (nameCounts.get(normalised) ?? 0) + 1;
    nameCounts.set(normalised, count);
    const component = { name: count > 1 ? `${name} (${count})` : name, percent, rowTexts: [rowText] };
    byKey.set(key, component);
    components.push(component);
  }
  return components;
}
