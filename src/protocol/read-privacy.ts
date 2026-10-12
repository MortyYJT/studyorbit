import { createRedactor, unsafeSource } from '../sync/redaction.js';
/** Model-facing reads never inherit an owner's disable/allow-list configuration. */
export function protectRead(value: unknown, scope: unknown = {}): unknown {
  const redactor = createRedactor({ scope, output: value });
  let nodes = 0;
  const visit = (item: unknown, depth = 0): unknown => {
    if (++nodes > 20000 || depth > 30) throw unsafeSource();
    if (typeof item === 'string') {
      const text = redactor.text(item);
      if (/(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Z]:\\|\.local\/)/iu.test(text)) throw unsafeSource();
      return text;
    }
    if (Array.isArray(item)) return item.map(v => visit(v, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
        const normalizedKey = key.normalize('NFKC');
        if (/^(?:authors?|users?|students?|classmates?|owners?|creators?|posters?|senders?|created_?by|updated_?by)_?(?:full_?|display_?|first_?|last_?)?name$|^(?:student_?(?:number|id)|username)$/i.test(normalizedKey)) throw unsafeSource();
        if (/^(?:password|credentials?|cookies?|tokens?|raw_?capture|raw_?path|file_?path|hidden_?(?:solutions?|answers?)|solutions?|correct_?answers?|people|students?|classmates?|authors?|users?|profiles?)$/i.test(normalizedKey)) throw unsafeSource();
        if (redactor.text(key) !== key) throw unsafeSource();
        const safe = visit(entry, depth + 1);
        // Identifiers/locators/hashes and accepted evidence must retain their exact meaning.
        if (/^(?:id|.*Id|.*Ref|.*Hash|locator|sourceRevision|revision)$/u.test(key) && safe !== entry) throw unsafeSource();
        return [key, safe];
      }));
    }
    return item;
  };
  return visit(value);
}
