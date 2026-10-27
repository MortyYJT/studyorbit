import { AgentFacingError } from '../protocol/errors.js';

/**
 * The Handbook skeleton (layered-sync task 4.1, #203, #214).
 *
 * The Handbook sits behind bot protection, so code never requests it. One short agent job opens the public
 * assessment page in the owner's Edge, copies the whole page and passes it to `handbook.capture` as `text` (#218);
 * this module parses the copied text. The real copied format is unknown until probe 1.3b,
 * so the parser is deliberately tolerant: a recognized header names the columns, rows are newline-separated and
 * cells are separated by tabs or runs of two or more spaces. Raw page text is never stored.
 */

export const HANDBOOK_ORIGIN = 'https://handbook.unimelb.edu.au';
export const MAX_HANDBOOK_BYTES = 1024 * 1024;

export interface HandbookComponent {
  name: string;
  weight?: number;
  timing?: string;
  hurdle?: string;
  /** The copied row text, capped at 2000 characters. */
  quote: string;
}

export interface SkeletonStage {
  source: string;
  via: 'handbook';
  components: HandbookComponent[];
  /** The page's hurdle section, kept even when it names no component. Capped at 2000 characters. */
  hurdles?: string;
}

/** The public assessment page for one course; the year comes from the course term (`YYYY:…`). */
export function handbookUrl(code: string, term: string): string {
  const year = /^(\d{4}):/.exec(term)?.[1];
  if (!year || !/^[A-Za-z]{4}\d{5}$/.test(code)) {
    throw new AgentFacingError('INVALID_INPUT', 'A course code and term are required for the Handbook URL.');
  }
  return `${HANDBOOK_ORIGIN}/${year}/subjects/${code.toLowerCase()}/assessment`;
}

const refuse = (reason: string): never => {
  throw new AgentFacingError('INVALID_INPUT', `${reason} Nothing was stored. Take a fresh copy of the assessment page and call handbook.capture again.`);
};

/** Cells are separated by tabs or runs of two or more spaces. Empty cells keep the header positions. */
function cells(line: string): string[] {
  // Leading tabs are empty cells, so only spaces and trailing whitespace are stripped before splitting.
  return line.replace(/^ +/, '').replace(/\s+$/, '').split(/\t| {2,}/).map(cell => cell.trim());
}

const labelIndex = (row: readonly string[], label: RegExp): number => row.findIndex(cell => label.test(cell));
/** A header names the three columns in three different cells, so prose mentioning all three words is not one. */
const isHeader = (row: readonly string[]): boolean => {
  const indices = [labelIndex(row, /description/i), labelIndex(row, /timing/i), labelIndex(row, /percentage/i)];
  return indices.every(index => index >= 0) && new Set(indices).size === 3;
};

const percent = (value: string | undefined): number | undefined => {
  const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(value ?? '');
  if (!match) return undefined;
  const weight = Number(match[1]);
  return Number.isFinite(weight) && weight >= 0 && weight <= 100 ? weight : undefined;
};

const sectionStart = (line: string): boolean => /^(?:hurdles?|additional requirements|special requirements|assessment details|fees|dates|contacts)\b/i.test(line);
const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const HURDLE_HEADING = /^hurdles?(?:\s+requirements?)?\s*(?:[:\-]\s*(.*))?$/i;
/** A bare section heading such as "Hurdle requirements" or "Fees", without text after it. */
const isSectionHeading = (line: string): boolean => /^[a-z ]+:?$/i.test(line.trim()) && line.trim().split(/\s+/).length <= 4;
const isHurdleHeading = (line: string): boolean => HURDLE_HEADING.test(line.trim());

/** Match a component name as whole words, so "Test" never matches inside "latest". */
function mentionsName(section: string, name: string): boolean {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  const words = normalized.split(' ').join('\\s+');
  return new RegExp(`\\b${words}\\b`).test(normalizeName(section));
}

/** The page's hurdle section: the heading text plus the paragraph under it, never following sections. */
function hurdleSection(lines: readonly string[], from: number): string | undefined {
  const index = lines.findIndex((line, position) => position >= from && isHurdleHeading(line));
  if (index < 0) return undefined;
  const heading = lines[index]!.trim();
  let text = (HURDLE_HEADING.exec(heading)?.[1] ?? '').trim();
  for (let position = index + 1; position < lines.length; position++) {
    const line = lines[position]!.trim();
    if (!line) {
      // Blank lines between the heading and its paragraph are layout; a blank line after the paragraph ends it.
      if (text) break;
      continue;
    }
    if (/^(?:assessment|fees|dates|contacts|careers|additional information)\b/i.test(line)) break;
    text = text ? `${text} ${line}` : line;
  }
  return text.slice(0, 2000).trim() || undefined;
}

const appendQuote = (quote: string, line: string): string => (quote ? `${quote}\n${line}` : line).slice(0, 2000);

function parseRow(row: readonly string[], columns: { description: number; timing: number; percentage: number }, line: string): HandbookComponent | undefined {
  const name = (columns.description >= 0 ? row[columns.description] : undefined)?.trim()
    || row.find(cell => cell.length > 0)?.trim();
  if (!name) return undefined;
  // A located Percentage column is authoritative: a percentage inside the name is never the weight.
  const weight = columns.percentage >= 0 ? percent(row[columns.percentage]) : undefined;
  const statedTiming = (columns.timing >= 0 ? row[columns.timing] : undefined)?.trim();
  const timing = statedTiming && percent(statedTiming) === undefined && statedTiming !== name ? statedTiming
    : row.find((cell, index) => index !== columns.description && cell.length > 0 && cell !== name && percent(cell) === undefined && !/hurdle/i.test(cell))?.trim();
  const hurdle = row.find(cell => /hurdle/i.test(cell))?.trim();
  return { name, ...(weight !== undefined ? { weight } : {}), ...(timing ? { timing } : {}),
    ...(hurdle ? { hurdle } : {}), quote: line.slice(0, 2000) };
}

/** Parse copied Handbook page text into the tentative skeleton; refuse oversized text or a page without a table. */
export function parseHandbook(text: string, options: { source: string }): SkeletonStage {
  if (Buffer.byteLength(text, 'utf8') > MAX_HANDBOOK_BYTES) refuse('The copied Handbook page is larger than 1 MB.');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let header = -1;
  for (let position = 0; position < lines.length; position++) {
    if (isHeader(cells(lines[position]!))) { header = position; break; }
  }
  if (header < 0) refuse('No assessment table was found in the copied Handbook page.');
  const headerRow = cells(lines[header]!);
  const columns = { description: labelIndex(headerRow, /description/i), timing: labelIndex(headerRow, /timing/i),
    percentage: labelIndex(headerRow, /percentage/i) };
  const components: HandbookComponent[] = [];
  let tableEnd = lines.length;
  let blankLines = 0;
  for (let position = header + 1; position < lines.length; position++) {
    const line = lines[position]!.trim();
    if (!line) {
      // One blank line is layout inside a long table; two in a row end it.
      blankLines++;
      if (blankLines >= 2) { tableEnd = position; break; }
      continue;
    }
    const afterBlank = blankLines > 0 && components.length > 0;
    blankLines = 0;
    const row = cells(lines[position]!);
    if (isHeader(row)) continue;
    const nonEmpty = row.filter(cell => cell.length > 0);
    const rowLike = nonEmpty.length >= 2 && (row.some(cell => percent(cell) !== undefined) || /hurdle/i.test(line));
    if (!rowLike) {
      // After a blank line, page text (a heading, a footer, prose) ends the table and is never quoted as a row.
      if (afterBlank || (sectionStart(line) && isSectionHeading(line))) { tableEnd = position; break; }
      // Directly under a row, the line wraps that row's description; a hurdle line there is that row's hurdle.
      const previous = components[components.length - 1];
      if (previous) {
        previous.quote = appendQuote(previous.quote, line);
        if (!previous.hurdle && /hurdle/i.test(line)) previous.hurdle = line.slice(0, 2000);
      }
      continue;
    }
    // A row after a blank line must have the header's shape; shorter lines are notes below the table.
    if (afterBlank && row.length < headerRow.length) { tableEnd = position; break; }
    if (/^total\b/i.test(nonEmpty[0]!)) continue;
    const component = parseRow(row, columns, line);
    if (component) components.push(component);
  }
  if (!components.length) refuse('No assessment table was found in the copied Handbook page.');
  const section = hurdleSection(lines, tableEnd);
  if (section) {
    for (const component of components) {
      if (component.hurdle || !mentionsName(section, component.name)) continue;
      component.hurdle = section;
    }
  }
  return { source: options.source, via: 'handbook', components, ...(section ? { hurdles: section } : {}) };
}
