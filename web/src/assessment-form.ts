// Pure parts of the assessment forms and of the jumps into a course page: what a typed value means, what is wrong
// with it, and which assessment a task or deadline opens. No DOM here, so it is unit-tested.

export type DueInput = { ok: true; value: string | null } | { ok: false };

const validDay = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/**
 * A due value typed into the correction form. Empty clears the date. A calendar day (`2026-12-10`, `2026/12/10`,
 * `2026-3-5`) becomes `YYYY-MM-DD`. A date-time with a zone is kept exactly as typed, so saving the form without
 * touching a synced date-time does not rewrite it. Anything else is refused: the page would show it but could not
 * place it on the calendar.
 */
export function parseDueInput(raw: string): DueInput {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const day = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    return validDay(year, month, date) ? { ok: true, value: `${day[1]}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}` } : { ok: false };
  }
  const instant = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (instant && validDay(Number(instant[1]), Number(instant[2]), Number(instant[3])) && !Number.isNaN(Date.parse(text))) return { ok: true, value: text };
  return { ok: false };
}

export type DueEdit = { ok: true; changed: false } | { ok: true; changed: true; value: string | null } | { ok: false };

/**
 * The due field of the correction form on save. `shown` is the value the form was filled with, which a sync or an
 * earlier version may have stored in any form ("Week 12", a date-time without a zone). Left as it was, it is not
 * read at all and no correction is written for it, so another field can be saved; only a changed value is parsed.
 */
export function dueEdit(raw: string, shown: string): DueEdit {
  if (raw.trim() === shown.trim()) return { ok: true, changed: false };
  const parsed = parseDueInput(raw);
  return parsed.ok ? { ok: true, changed: true, value: parsed.value } : { ok: false };
}

export type NumberProblem = 'weight' | 'score' | 'outOf' | 'scoreOverMax';

/** The first thing wrong with the weight, score and maximum typed into an assessment form, or null. Empty is allowed. */
export function numberProblem(fields: { weight: string; score: string; outOf: string }): NumberProblem | null {
  const read = (value: string) => { const text = value.trim(); return text === '' ? undefined : Number(text); };
  const weight = read(fields.weight), score = read(fields.score), outOf = read(fields.outOf);
  if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 100)) return 'weight';
  if (score !== undefined && (!Number.isFinite(score) || score < 0)) return 'score';
  if (outOf !== undefined && (!Number.isFinite(outOf) || outOf < 0)) return 'outOf';
  if (score !== undefined && outOf !== undefined && score > outOf) return 'scoreOverMax';
  return null;
}

/** The states the plan understands: only `submitted` and `graded` count a deadline as done. */
export const knownStatuses = ['not_started', 'in_progress', 'submitted', 'graded'] as const;

/** Choices for the status field: "not set", the known states, and a stored value that is neither (kept, not lost). */
export function statusOptions(current: string): string[] {
  const known: string[] = ['', ...knownStatuses];
  return current && current !== 'unknown' && !known.includes(current) ? [...known, current] : known;
}

/**
 * Which assessment of `courseId` a task or deadline key opens. `group` is true when the whole assessment with its
 * parts is meant: a task that plans the group (`<course>:group:<key>`), or an assessment that has parts. Null for a
 * personal task and for a key whose assessment is not on the page.
 */
export function assessmentJump(key: string, courseId: string, items: { key: string; parent: string }[]): { key: string; group: boolean } | null {
  const prefix = `${courseId}:group:`;
  const target = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  if (!target.startsWith(`${courseId}:`) || !items.some(item => item.key === target)) return null;
  return { key: target, group: key.startsWith(prefix) || items.some(item => item.parent === target) };
}
