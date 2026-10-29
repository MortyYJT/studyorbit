// The UniMelb Handbook as the institution's framework source (openspec change generic-adapters, design §4): the
// official assessment framework of a subject for a year. The collector moved unchanged to handbook-collect.mjs and the
// parsers to handbook-parse.mjs. The contract keeps the reference and source platform value `handbook`.
import { parseHandbookComponents, parseHandbookRows } from './handbook-parse.mjs';

export const HANDBOOK_ORIGIN = 'https://handbook.unimelb.edu.au';

export const handbookSource = Object.freeze({
  id: 'handbook',
  label: 'Handbook',
  usesBrowser: true,
  limiter: 'browser',
  platforms: Object.freeze(['handbook']),
  platform: 'handbook',
  origins: Object.freeze([HANDBOOK_ORIGIN]),
  /** `<CODE> <year> <out>`; null without a year in the term (as before the move). */
  collect(course, ctx, out) {
    const year = /\b(20\d{2})\b/.exec(typeof course.term === 'string' ? course.term : '')?.[1];
    return year ? { script: 'institutions/unimelb/handbook-collect.mjs', args: [course.subjectCode, year, out], env: { ...ctx.env } } : null;
  },
  placeholder: (reason = 'Handbook 采集不可用') => ({ status: 'unavailable', reason }),
  parseRows: parseHandbookRows,
  parseComponents: parseHandbookComponents,
  promptRules: Object.freeze({
    refs: 'handbook 只能填 handbookComponents 中列出的 name，不得自拟、缩写或截取。',
    quote: 'Handbook 考核表的一行、Handbook 的其他行、',
    quoteRow: '引用 Handbook 考核表的一行时，按从左到右的顺序复制该行各格，格与格之间用单个空格分隔（如 "Project report Week 10 30%"）。',
    percent: '或所引 Handbook 考核项的百分比',
  }),
});
