// The `generic` institution plugin (openspec change generic-adapters, design §4, decision #441): any Canvas instance,
// without assumptions about one university. A course is a candidate when its trimmed `course_code` matches the owner's
// code pattern (one capture group) or, without one, a short code of safe characters; terms give a year and no session;
// Desktop folders are `StudyOrbit <term>/<code>` with every segment reduced to safe characters; the time zone comes
// from the settings; the wording is neutral; there is no framework source.

/** The system's IANA time zone. */
export const systemTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Without an owner pattern: a short code of letters, digits, spaces, dots, underscores and hyphens. */
export const DEFAULT_CODE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/;
/** Course codes longer than this are never tested against the owner's pattern. */
export const CODE_INPUT_LIMIT = 100;
/** Windows device names, refused as a folder name with or without an extension. */
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$/i;

/**
 * One Desktop path segment: characters outside `[A-Za-z0-9 ._-]` become `_`, runs of spaces collapse, leading and
 * trailing spaces and trailing dots go, at most 100 characters; never empty, `.`, `..` or a Windows device name.
 */
export function folderSegment(value) {
  let text = String(value ?? '').replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/ {2,}/g, ' ').trim().slice(0, 100).replace(/[. ]+$/, '');
  if (!text || /^\.+$/.test(text)) text = '_';
  if (RESERVED.test(text)) text = `_${text}`;
  return text;
}

/** The term name with characters outside `[A-Za-z0-9 ._-]` removed, at most 50 characters. */
function termLabel(term) {
  const value = typeof term === 'string' ? term : '';
  return value.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, 50) || 'Unknown term';
}

/**
 * The owner's code pattern compiled, or a reason it is unusable: at most 200 characters, compiles without flags, and
 * has exactly one capture group (counted by matching the empty alternative `|` appended to it).
 */
export function compileCodePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 200) return { ok: false, reason: '代码正则最多 200 个字符' };
  let regex;
  try { regex = new RegExp(pattern); } catch { return { ok: false, reason: '代码正则无法编译' }; }
  const groups = new RegExp(`${pattern}|`).exec('').length - 1;
  if (groups !== 1) return { ok: false, reason: '代码正则必须恰好有一个捕获组' };
  return { ok: true, regex };
}

/**
 * A generic institution for the owner's settings: `codePattern` (string or null) and `timeZone` (an IANA name, or null
 * for the system's zone at the time of use).
 */
export function createGenericInstitution({ codePattern = null, timeZone = null } = {}) {
  const pattern = codePattern === null ? null : compileCodePattern(codePattern);
  if (pattern && !pattern.ok) throw new Error(pattern.reason);
  return Object.freeze({
    id: 'generic',
    label: Object.freeze({ zh: '其他学校（通用 Canvas）', en: 'Other institution (any Canvas)' }),
    defaults: Object.freeze({ canvasOrigin: null, timeZone }),
    /** The trimmed code, or the owner's capture group; null without a usable code. */
    subjectCode(courseCode) {
      if (typeof courseCode !== 'string') return null;
      const value = courseCode.trim();
      if (!value || value.length > CODE_INPUT_LIMIT) return null;
      if (!pattern) return DEFAULT_CODE.test(value) ? value : null;
      const code = pattern.regex.exec(value)?.[1]?.trim();
      return code && code.length <= CODE_INPUT_LIMIT ? code : null;
    },
    /** Any non-empty trimmed string without control characters, up to 100 characters (folders are sanitised). */
    isSubjectCode: code => typeof code === 'string' && code.length > 0 && code.length <= CODE_INPUT_LIMIT && code === code.trim() && !/[\u0000-\u001f\u007f]/.test(code),
    /** The first `20xx` of the term as the year; never a session. */
    termKey(term) {
      const year = /20\d{2}/.exec(typeof term === 'string' ? term : '')?.[0] ?? null;
      return { year, session: null };
    },
    termLabel,
    courseFolder: ({ term, subjectCode }) => [folderSegment(`StudyOrbit ${termLabel(term)}`), folderSegment(subjectCode)],
    /** Without a session in the term, an Ed unit matches by code and year alone. */
    edSessionMatches: (_session, key) => key.session === null,
    wording: Object.freeze({
      assistantIntro: Object.freeze({
        zh: '你是一名大学生的学习助手，运行在他自己的课程管理工具里。',
        en: 'You are a study assistant for one university student, inside their personal coursework tool.',
      }),
      timeLabel: Object.freeze({ zh: '本地时间', en: 'local' }),
      sourcesRule: 'Canvas 提供具体考核、分组和权重；Ed 补充考核说明。某来源缺失时使用其他来源，不捏造缺失来源。',
    }),
    framework: null,
  });
}

/** The generic institution without an owner pattern or time zone. */
export const generic = createGenericInstitution();
