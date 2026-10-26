import { AgentFacingError } from '../protocol/errors.js';

/**
 * The Handbook skeleton (layered-sync task 4.1, #203, #214).
 *
 * The Handbook sits behind bot protection, so code never requests it. One short agent job opens the public
 * assessment page in the owner's Edge, copies the whole page and calls `handbook.capture`; the command reads the
 * clipboard itself and this module parses the copied text. The real copied format is unknown until probe 1.3b,
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
  return line.trim().split(/\t+|\s{2,}/).map(cell => cell.trim());
}

const labelIndex = (row: readonly string[], label: RegExp): number => row.findIndex(cell => label.test(cell));
const isHeader = (row: readonly string[]): boolean =>
  labelIndex(row, /description/i) >= 0 && labelIndex(row, /timing/i) >= 0 && labelIndex(row, /percentage/i) >= 0;

const percent = (value: string | undefined): number | undefined => {
  const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(value ?? '');
  if (!match) return undefined;
  const weight = Number(match[1]);
  return Number.isFinite(weight) && weight >= 0 && weight <= 100 ? weight : undefined;
};

const sectionStart = (line: string): boolean => /^(?:hurdles?|additional requirements|special requirements|assessment details|fees|dates|contacts)\b/i.test(line);
const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The page's hurdle section: the heading text plus the paragraph under it, never following sections. */
function hurdleSection(lines: readonly string[], from: number): string | undefined {
  const index = lines.findIndex((line, position) => position >= from && /hurdle/i.test(line));
  if (index < 0) return undefined;
  const heading = lines[index]!.trim();
  let text = '';
  const labelled = /^hurdles?(?:\s+requirements?)?\s*[:\-]\s*(.*)$/i.exec(heading);
  if (labelled) text = labelled[1]!.trim();
  else if (!/^hurdles?(?:\s+requirements?)?\s*$/i.test(heading)) text = heading.replace(/^hurdles?(?:\s+requirements?)?\s*[:\-]?\s*/i, '').trim();
  for (let position = index + 1; position < lines.length; position++) {
    const line = lines[position]!.trim();
    if (!line) break;
    if (/^(?:assessment|fees|dates|contacts|careers|additional information)\b/i.test(line)) break;
    text = text ? `${text} ${line}` : line;
  }
  return text.slice(0, 2000).trim() || undefined;
}

function parseRow(row: readonly string[], columns: { description: number; timing: number; percentage: number }, line: string): HandbookComponent | undefined {
  const name = (columns.description >= 0 ? row[columns.description] : undefined)?.trim()
    || row.find(cell => cell.length > 0)?.trim();
  if (!name) return undefined;
  const weight = percent(columns.percentage >= 0 ? row[columns.percentage] : undefined)
    ?? row.map(cell => percent(cell)).find(value => value !== undefined);
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
  for (let position = header + 1; position < lines.length; position++) {
    const line = lines[position]!.trim();
    if (!line) {
      // A blank line after the table ends it; blank lines before the first row are layout.
      if (components.length) { tableEnd = position; break; }
      continue;
    }
    if (sectionStart(line)) { tableEnd = position; break; }
    const row = cells(line);
    if (isHeader(row)) continue;
    if (row.filter(cell => cell.length > 0).length < 2 && percent(line) === undefined) { tableEnd = position; break; }
    const component = parseRow(row, columns, line);
    if (!component) {
      if (components.length) { tableEnd = position; break; }
      continue;
    }
    components.push(component);
  }
  if (!components.length) refuse('No assessment table was found in the copied Handbook page.');
  const section = hurdleSection(lines, tableEnd);
  if (section) {
    const mentioned = normalizeName(section);
    for (const component of components) {
      if (component.hurdle || !mentioned.includes(normalizeName(component.name))) continue;
      component.hurdle = section;
    }
  }
  return { source: options.source, via: 'handbook', components };
}
