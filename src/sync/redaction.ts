import { z } from 'zod';
import { CourseworkError } from '../protocol/errors.js';
const literal = z.string().trim().min(1).max(200).refine(s => !/[<>\p{C}]/u.test(s));
const rulesSchema = z.strictObject({ ownerRules: z.array(literal).max(100).optional(), staffNames: z.array(literal).max(100).optional() });
const personKey = /^(?:authors?|people|students?|classmates?|users?|profiles?|owners?|created_by|updated_by)$/i;
const nameKey = /^(?:name|full_?name|display_?name|first_?name|last_?name)$/i;
const safePersonKey = /^(?:name|full_?name|display_?name|first_?name|last_?name|id|email|phone|student_?number|avatar|username|answers?|grades?|solutions?)$/i;
export function unsafeSource(): CourseworkError { return new CourseworkError('SOURCE_UNAVAILABLE', 'Normalized source withheld by privacy validation.'); }
/** Scope-wide harvesting must finish before any projection. Owner rules are literals, never executable regexes. */
export function createRedactor(scope: unknown, configuration: unknown = {}): { text(value: unknown): string } {
  const parsed = rulesSchema.safeParse(configuration);
  if (!parsed.success) throw unsafeSource();
  const names = new Set<string>(); const identifiers = new Set<string>(); let nodes = 0;
  const identity = (value: unknown, into: Set<string>) => {
    const p = literal.safeParse(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
    if (!p.success) throw unsafeSource();
    into.add(p.data.normalize('NFKC'));
  };
  const collect = (value: unknown, depth = 0, person = false): void => {
    if (++nodes > 20000 || depth > 30) throw unsafeSource();
    if (typeof value === 'string' && value.length > 1_000_000) throw unsafeSource();
    if (Array.isArray(value)) { for (const v of value) collect(v, depth + 1, person); }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (person && typeof item === 'string' && !safePersonKey.test(key)) throw unsafeSource();
      if (person && nameKey.test(key)) { identity(item, names); continue; }
      if (person && /^(?:username|student_?number)$/i.test(key)) { identity(item, identifiers); continue; }
      if (personKey.test(key) && typeof item === 'string') { identity(item, names); continue; }
      collect(item, depth + 1, person || personKey.test(key));
    }
    else if (person && typeof value === 'string') identity(value, names);
  };
  collect(scope);
  const staff = new Set((parsed.data.staffNames ?? []).map(n => n.normalize('NFKC').toLocaleLowerCase('en')));
  const patterns = [...new Set([...names].filter(n => !staff.has(n.toLocaleLowerCase('en'))).concat([...identifiers], parsed.data.ownerRules ?? []))]
    .sort((a, b) => b.length - a.length || a.localeCompare(b, 'en')).map(n => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'));
  return { text(value: unknown): string {
    if (typeof value !== 'string' || value.length > 1_000_000) throw unsafeSource();
    let text = value.normalize('NFKC');
    // Decode URL escapes before privacy checks; malformed encodings cannot fall back to raw text.
    text = text.replace(/https?:\/\/[^\s]+/giu, raw => {
      try { let decoded = decodeURIComponent(raw); for (let i = 0; i < 3 && /%[a-f0-9]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded); if (/%[a-f0-9]{2}/i.test(decoded)) throw unsafeSource(); const url = new URL(decoded); if (url.username || url.password) throw unsafeSource(); return decoded; }
      catch { throw unsafeSource(); }
    });
    if (/[\p{C}]/u.test(text.replace(/[\t\n\r]/g, '')) || /[<>\u0000-\u0008\u000b-\u001f\u007f]|authToken|x-token|authorization|\b(?:password|csrf|access_token)\b/i.test(text)
      || /\b(?:token|api[_-]?key|secret|session[_-]?id|cookie)\s*[:=]|\bbearer\s+\S/i.test(text)) throw unsafeSource();
    for (const pattern of patterns) text = text.replace(pattern, '[redacted]');
    text = text.replace(/\b((?:student\s*(?:number|no\.?|id)|id)\s*[:#]?\s*)\d{6,}\b/giu, '$1[redacted]').replace(/[^\s/?:#=&]*@[^\s/?:#=&]+/gu, '[redacted]')
      .replace(/\b\d{7,10}\b/gu, '[redacted]')
      .replace(/\+\d{1,3}[\s()-]*\d(?:[\d ()-]{6,}\d)|\b0[23478](?:[\d ()-]{6,}\d)|\b\d{3}[ -]\d{3}[ -]\d{4}\b/gu, '[redacted]');
    for (const pattern of patterns) { pattern.lastIndex = 0; if (pattern.test(text)) throw unsafeSource(); }
    if (/\b(?:classmate|student|author|user)\s+(?!(?:\[redacted\]|number\b|id\b))\p{L}+/iu.test(text)) throw unsafeSource();
    return text;
  } };
}
