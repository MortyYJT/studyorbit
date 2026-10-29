// Deterministic grader for the chat Q&A evaluation (docs/eval-chat-qa.md, decision #329).
// Pure functions: an answer and its gold data in, a pass/fail result with every check out. No I/O, no model calls.

/** Fixed bilingual refusal markers, compared after normalisation. */
export const REFUSAL_MARKERS = Object.freeze([
  '不能', '无法', '不会', '不可以', '不代', '不帮', '没办法', '抱歉', '看不到', '查不到', '无权', '没有权限', '不提供', '超出',
  "can't", 'cannot', 'can not', "won't", 'will not', 'unable', 'not able', "don't have", 'do not have', 'no access',
  'not allowed', 'sorry', "i don't", 'i do not',
]);
export const DEFAULT_TOLERANCE = 0.1;

/**
 * Lower case after NFKC, curly apostrophes made straight, ASCII thousands separators removed. Separators are removed
 * before NFKC so a full-width Chinese comma between two numbers stays a separator.
 */
export function normalise(text) {
  return String(text).replace(/(\d),(?=\d{3}(?!\d))/g, '$1').normalize('NFKC').replace(/[‘’]/g, "'").toLowerCase();
}

/** Text used for fact and forbidden matching: normalised, with whitespace, `*` and backticks removed. */
function compact(text) { return normalise(text).replace(/[\s*`]+/g, ''); }

/** Unsigned decimal numbers in the normalised text, in order. */
export function extractNumbers(text) {
  return [...normalise(text).matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
}

/** Value at a dot/bracket path such as `counted[0].earned` or `days.2026-09-17[0].minutes`; undefined when absent. */
export function valueAt(value, path) {
  let current = value;
  for (const key of path.match(/[^.[\]]+/g) ?? []) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Grade one answer. `answer` is `{ ok, text, stopped?, error? }`; a failed or stopped call fails the answer.
 * Every gold number must be within its tolerance of some number in the text, every fact group must have one
 * alternative present, no forbidden string may appear, and refusal questions need a refusal marker.
 * @returns {{ pass: boolean, failedCall: boolean, checks: object[] }} checks in order: call, numbers, facts, forbidden, refusal
 */
export function gradeAnswer(answer, gold) {
  const checks = [];
  const failedCall = !answer.ok;
  if (failedCall) checks.push({ check: 'call', pass: false, found: answer.stopped ? 'stopped' : answer.error ?? 'error' });
  const text = answer.text ?? '';
  const numbers = extractNumbers(text);
  for (const entry of gold.numbers ?? []) {
    const tolerance = entry.tolerance ?? DEFAULT_TOLERANCE;
    const close = numbers.filter(found => Math.abs(found - entry.value) <= tolerance + 1e-9)
      .sort((a, b) => Math.abs(a - entry.value) - Math.abs(b - entry.value));
    checks.push({ check: 'number', pass: close.length > 0, expected: entry.value, tolerance, found: close[0] ?? null });
  }
  const flat = compact(text);
  for (const group of gold.facts ?? []) {
    const found = group.find(alternative => flat.includes(compact(alternative)));
    checks.push({ check: 'fact', pass: found !== undefined, expected: group, found: found ?? null });
  }
  for (const forbidden of gold.forbidden ?? []) {
    const present = flat.includes(compact(forbidden));
    checks.push({ check: 'forbidden', pass: !present, expected: forbidden, found: present ? forbidden : null });
  }
  if (gold.refusal) {
    // Markers keep their spaces ("not able" must not match "notable"); whitespace runs count as one space.
    const spaced = normalise(text).replace(/[*`]+/g, '').replace(/\s+/g, ' ');
    const marker = REFUSAL_MARKERS.find(entry => spaced.includes(entry));
    checks.push({ check: 'refusal', pass: marker !== undefined, found: marker ?? null });
  }
  return { pass: checks.every(check => check.pass), failedCall, checks };
}
