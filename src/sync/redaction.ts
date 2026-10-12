import { z } from 'zod';
import { CourseworkError } from '../protocol/errors.js';
const literal = z.string().trim().min(1).max(200).refine(s => !/[<>\p{C}]/u.test(s));
const rulesSchema = z.strictObject({ ownerRules: z.array(literal).max(100).optional(), staffNames: z.array(literal).max(100).optional() });
const personKey = /^(?:authors?|people|students?|classmates?|users?|profiles?|owners?|created_by|updated_by)$/i;
const nameKey = /^(?:name|full_?name|display_?name|first_?name|last_?name)$/i;
const phoneKey = /^(?:phone|mobile|telephone|tel)(?:_?number)?$/i;
const identifierKey = /^(?:username|student_?(?:number|id))$/i;
// Flat person-name fields outside a person object, e.g. `author_name` on a thread.
const flatNameKey = /^(?:authors?|users?|students?|classmates?|owners?|creators?|posters?|senders?|created_?by|updated_?by)_?(?:full_?|display_?|first_?|last_?)?name$/i;
const safePersonKey = /^(?:name|full_?name|display_?name|first_?name|last_?name|id|email|(?:phone|mobile|telephone|tel)(?:_?number)?|student_?(?:number|id)|avatar|username|answers?|grades?|solutions?)$/i;
const canonical = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const credentialSyntax = /authToken|x-token|authorization|\b(?:password|csrf|access_token)\b|\b(?:token|api[_-]?key|secret|session[_-]?id|cookie)\s*[:=]|\bbearer\s+\S/iu;
export function unsafeSource(): CourseworkError { return new CourseworkError('SOURCE_UNAVAILABLE', 'Normalized source withheld by privacy validation.'); }
/** Scope-wide harvesting must finish before any projection. Owner rules are literals, never executable regexes. */
export function createRedactor(scope: unknown, configuration: unknown = {}): { text(value: unknown): string; readText(value: unknown): string; url(value: string): string; identifier(value: string): boolean } {
  const parsed = rulesSchema.safeParse(configuration);
  if (!parsed.success) throw unsafeSource();
  const names = new Set<string>(); const identifiers = new Set<string>(); const phones = new Set<string>(); let nodes = 0;
  const identity = (value: unknown, into: Set<string>) => {
    const p = literal.safeParse(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
    if (!p.success) throw unsafeSource();
    const normalized = canonical(p.data);
    if (!literal.safeParse(normalized).success) throw unsafeSource();
    into.add(normalized);
  };
  const collect = (value: unknown, depth = 0, person = false): void => {
    if (++nodes > 20000 || depth > 30) throw unsafeSource();
    if (typeof value === 'string' && value.length > 1_000_000) throw unsafeSource();
    if (Array.isArray(value)) { for (const v of value) collect(v, depth + 1, person); }
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      // Unknown primitive person fields are withheld whatever their type; a number can be an identifier too.
      if (person && item !== null && typeof item !== 'object' && !safePersonKey.test(key)) throw unsafeSource();
      if (flatNameKey.test(key)) { identity(item, names); continue; }
      if (person && nameKey.test(key)) { identity(item, names); continue; }
      if (person && (/^email$/i.test(key) || phoneKey.test(key))) {
        if (phoneKey.test(key)) {
          const raw = typeof item === 'number' && Number.isSafeInteger(item) ? String(item) : item;
          if (typeof raw !== 'string') throw unsafeSource();
          const normalized = canonical(raw);
          if (!/^\+?\d[\d ().-]*\d$/u.test(normalized)) throw unsafeSource();
          const digits = normalized.replace(/\D/gu, '');
          if (digits.length < 7 || digits.length > 15) throw unsafeSource();
          phones.add(digits);
        } else identity(item, identifiers);
        continue;
      }
      if (person && identifierKey.test(key)) { identity(item, identifiers); continue; }
      if (personKey.test(key) && typeof item === 'string') { identity(item, names); continue; }
      collect(item, depth + 1, person || personKey.test(key));
    }
    else if (person && typeof value === 'string') identity(value, names);
  };
  collect(scope);
  const staff = new Set((parsed.data.staffNames ?? []).map(n => canonical(n).toLocaleLowerCase('en')));
  const ownerRules = (parsed.data.ownerRules ?? []).map(canonical);
  if (ownerRules.some(n => !literal.safeParse(n).success)) throw unsafeSource();
  // Match canonical whitespace without rewriting unrelated source formatting.
  const patterns = [...new Set([...names].filter(n => !staff.has(n.toLocaleLowerCase('en'))).concat([...identifiers], ownerRules))]
    .sort((a, b) => b.length - a.length || a.localeCompare(b, 'en')).map(n => new RegExp(n.split(' ').map(escapeLiteral).join('\\s+'), 'giu'));
  patterns.push(...[...phones].sort().map(n => new RegExp(`\\+?${n.split('').join('[\\s().-]*')}`, 'gu')));
  const personalIdentity = (value: string): boolean => patterns.some(pattern => {
    pattern.lastIndex = 0; return pattern.test(value.normalize('NFKC'));
  });
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 1_000_000) throw unsafeSource();
    let text = value.normalize('NFKC');
    // Decode URL escapes before privacy checks; malformed encodings cannot fall back to raw text.
    text = text.replace(/https?:\/\/[^\s]+/giu, raw => {
      try { const [base, ...query] = raw.split('?'); let decoded = decodeURIComponent(query.length ? `${base}?${query.join('?').replace(/\+/g, '%20')}` : raw); for (let i = 0; i < 3 && /%[a-f0-9]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded); if (/%[a-f0-9]{2}/i.test(decoded)) throw unsafeSource(); const url = new URL(decoded); if (url.username || url.password) throw unsafeSource(); return decoded; }
      catch { throw unsafeSource(); }
    });
    text = text.normalize('NFKC');
    if (/[\p{C}]/u.test(text.replace(/[\t\n\r]/g, '')) || /[<>]/u.test(text) || credentialSyntax.test(text)) throw unsafeSource();
    for (const pattern of patterns) text = text.replace(pattern, '[redacted]');
    text = text.replace(/\b((?:student[\s_-]*(?:number|no\.?|id)|sid|id)\s*[:#=-]?\s*)\d{6,}\b/giu, '$1[redacted]').replace(/[^\s/?:#=&]*@[^\s/?:#=&]+/gu, '[redacted]')
      // Decision #81 preserves untagged six/seven-digit mathematical values; labelled ids are redacted above.
      .replace(/\b\d{8,15}\b/gu, '[redacted]')
      .replace(/\+\d{1,3}[\s()-]*\d(?:[\d ()-]{6,}\d)|\b0[23478](?:[\d ()-]{6,}\d)|\b\d{3}[ -]\d{3}[ -]\d{4}\b/gu, '[redacted]');
    for (const pattern of patterns) { pattern.lastIndex = 0; if (pattern.test(text)) throw unsafeSource(); }
    if (/\b(?:classmate|student|author|user)\s+(?!(?:\[redacted\]|number\b|id\b))\p{L}+/iu.test(text)) throw unsafeSource();
    return text;
  };
  const decode = (value: string): string => {
    try {
      let decoded = decodeURIComponent(value);
      for (let i = 0; i < 3 && /%[a-f0-9]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded);
      if (/%[a-f0-9]{2}/i.test(decoded)) throw unsafeSource();
      return decoded.normalize('NFKC');
    } catch { throw unsafeSource(); }
  };
  const url = (value: string): string => {
    // Validate the fully decoded URL for secrets, credentials and malformed escapes first.
    text(value);
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) throw unsafeSource();
    const component = (raw: string, numericPath = false, query = false): string => {
      const decoded = decode(query ? raw.replace(/\+/g, '%20') : raw);
      // Provider object numbers in path segments are identifiers, not free-text student numbers.
      const safe = numericPath && /^\d+$/.test(decoded) && !personalIdentity(decoded) ? decoded : text(decoded);
      return safe === decoded && decoded === decodeURIComponent(query ? raw.replace(/\+/g, '%20') : raw)
        ? raw : encodeURIComponent(safe);
    };
    const host = text(parsed.host);
    if (host !== parsed.host) throw unsafeSource();
    // Preserve untouched escaping and query spelling instead of URLSearchParams reserialization.
    const match = /^(https?:\/\/[^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/iu.exec(value);
    if (!match) throw unsafeSource();
    const [, base, path, query, fragment] = match;
    if (text(base) !== decode(base)) throw unsafeSource();
    const personalQuery = (raw: string): boolean => {
      const key = decode(raw.replace(/\+/g, '%20')).replace(/[\s-]/gu, '_');
      return identifierKey.test(key) || nameKey.test(key) || flatNameKey.test(key) || phoneKey.test(key)
        || /^(?:student(?:_?(?:number|no|id))?|person|email)$/iu.test(key);
    };
    return base + path.split('/').map(part => component(part, true)).join('/')
      + (query === undefined ? '' : '?' + query.split('&').map(pair => {
        const index = pair.indexOf('=');
        return index < 0 ? component(pair, false, true)
          : component(pair.slice(0, index), false, true) + '='
            + (personalQuery(pair.slice(0, index))
              ? encodeURIComponent('[redacted]') : component(pair.slice(index + 1), false, true));
      }).join('&')) + (fragment === undefined ? '' : '#' + component(fragment));
  };
  return { text, url,
    readText(value: unknown): string {
      if (typeof value !== 'string' || value.length > 1_000_000) throw unsafeSource();
      return value.split(/(https?:\/\/[^\s]+)/giu).map(part => /^https?:\/\//i.test(part) ? url(part) : text(part)).join('');
    },
    identifier(value: string): boolean {
      // Structural fields retain numeric runs. Harvested identities and sensitive syntax still fail closed.
      const inspected = decode(value);
      if (personalIdentity(inspected) || credentialSyntax.test(inspected)) return false;
      return !/[\p{C}<>@]|(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Z]:\\|\.local\/)|\b(?:student|classmate|author|user)\s+/iu.test(inspected);
    },
  };
}
