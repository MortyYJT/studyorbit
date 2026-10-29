// The `unimelb` institution plugin (openspec change generic-adapters, design §4, decision #441): exactly the
// University of Melbourne behaviour StudyOrbit had before the change — subject codes, "Semester 1/2" terms, Desktop
// folders `墨尔本大学 <year> S<n>/<CODE>`, the Melbourne time zone, the prompt wording and the Handbook framework
// source. Every string here is today's, byte for byte (test/golden-unimelb.test.ts).
import { handbookSource } from './handbook-source.mjs';

export const UNIMELB_CANVAS_ORIGIN = 'https://canvas.lms.unimelb.edu.au';
const SUBJECT_CODE = /^[A-Z]{4}[1-9]\d{4}$/;

/** Desktop folder label for a Canvas term, e.g. "2026 S2". */
function termLabel(term) {
  const value = typeof term === 'string' ? term : '';
  const match = /(20\d{2}).*?(?:semester|sem)\s*([12])/i.exec(value);
  return match ? `${match[1]} S${match[2]}` : value.replace(/[^\w\u4e00-\u9fff -]/g, '').trim().slice(0, 50) || '未知学期';
}

export const unimelb = Object.freeze({
  id: 'unimelb',
  label: Object.freeze({ zh: '墨尔本大学', en: 'The University of Melbourne' }),
  defaults: Object.freeze({ canvasOrigin: UNIMELB_CANVAS_ORIGIN, timeZone: 'Australia/Melbourne' }),
  /** Subject code at the start of a Canvas `course_code`, without using the title as evidence. */
  subjectCode(courseCode) {
    if (typeof courseCode !== 'string') return null;
    return /^([A-Z]{4}[1-9]\d{4})(?:_|$)/i.exec(courseCode.trim())?.[1].toUpperCase() ?? null;
  },
  isSubjectCode: code => typeof code === 'string' && SUBJECT_CODE.test(code),
  /** Year and semester of a Canvas term; both or neither, since a UniMelb Ed unit is identified by both. */
  termKey(term) {
    const year = /\b(20\d{2})\b/.exec(term ?? '')?.[1];
    const session = /(?:semester|sem)\s*([12])/i.exec(term ?? '')?.[1];
    return year && session ? { year, session } : { year: null, session: null };
  },
  termLabel,
  courseFolder: ({ term, subjectCode }) => [`墨尔本大学 ${termLabel(term)}`, subjectCode],
  /** Whether an Ed unit's session names the semester of `key` ("Semester 2", "Sem 2"). */
  edSessionMatches: (session, key) => key.session !== null && new RegExp(`(?:semester|sem)\\s*${key.session}\\b`, 'i').test(String(session)),
  wording: Object.freeze({
    assistantIntro: Object.freeze({
      zh: '你是一名墨尔本大学学生的学习助手，运行在他自己的课程管理工具里。',
      en: 'You are a study assistant for one University of Melbourne student, inside their personal coursework tool.',
    }),
    timeLabel: Object.freeze({ zh: '墨尔本时间', en: 'Melbourne' }),
    sourcesRule: 'Handbook 提供对应年份和学期的官方考核框架、权重和 hurdle；Canvas 补充具体考核与分组；Ed 补充考核说明。某来源缺失时使用其他来源，不捏造缺失来源。',
  }),
  framework: handbookSource,
});
