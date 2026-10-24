import { z } from 'zod';
import { IdSchema, HashSchema, CursorSchema } from './contracts.js';
import { SourceItemSchema } from '../domain/schemas.js';
import { createRedactor, unsafeSource, type TextMode } from '../sync/redaction.js';
/**
 * Model-facing reads never inherit an owner's disable/allow-list configuration. Objects marked `copiedBy: 'agent'`
 * (source.record text, #187) and `options.agentCopy` use the agent-copy text mode for their strings.
 */
export function protectRead(value: unknown, scope: unknown = {}, options: Pick<TextMode, 'agentCopy'> = {}): unknown {
  const redactor = createRedactor({ scope, output: value });
  let nodes = 0;
  const privatePath = (value: string): boolean => /(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Z]:\\|\.local\/)/iu.test(value);
  const visit = (item: unknown, depth = 0, key = '', mode: TextMode = options): unknown => {
    if (++nodes > 20000 || depth > 30) throw unsafeSource();
    if (item !== undefined && /^(?:id|.*Id|.*Ref|.*Hash|sourceRevision|.*[Rr]evision|nextCursor|cursor|reference)$/u.test(key)) {
      const schema = /^(?:nextCursor|cursor)$/.test(key)
        ? typeof item === 'number' ? z.number().int().nonnegative().safe() : CursorSchema
        : key === 'contentHash' ? SourceItemSchema.shape.contentHash
        : /Hash$|^(?:sourceRevision|policyRef|grantRef|scopeRef)$/.test(key) ? HashSchema
        : /[Rr]evision$/.test(key) ? z.uuid() : IdSchema;
      const parsed = schema.safeParse(item);
      if (!parsed.success || parsed.data !== item) throw unsafeSource();
      // A validated SHA-256 digest has no free-text identity semantics.
      if (schema === HashSchema || key === 'contentHash' && HashSchema.safeParse(item).success) return item;
      if (typeof item === 'string' && (!redactor.identifier(item) || privatePath(item.normalize('NFKC')))) throw unsafeSource();
      return item;
    }
    if (typeof item === 'string') {
      // Check decoded URLs too, so encoding cannot hide a local filesystem path.
      const inspected = redactor.text(item, mode);
      if (privatePath(inspected)) throw unsafeSource();
      const text = redactor.readText(item, mode);
      if (privatePath(text)) throw unsafeSource();
      return text;
    }
    if (Array.isArray(item)) return item.map(v => visit(v, depth + 1, '', mode));
    if (item && typeof item === 'object') {
      // Only a stored SourceItem (contentHash) or source evidence (sourceHash) carries the agent-copy marker.
      const marked = item as { copiedBy?: unknown; contentHash?: unknown; sourceHash?: unknown };
      const inner: TextMode = marked.copiedBy === 'agent' && (typeof marked.contentHash === 'string' || typeof marked.sourceHash === 'string')
        ? { agentCopy: true } : mode;
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
        const normalizedKey = key.normalize('NFKC');
        if (/^(?:authors?|users?|students?|classmates?|owners?|creators?|posters?|senders?|created_?by|updated_?by)_?(?:full_?|display_?|first_?|last_?)?name$|^(?:student_?(?:number|id)|username)$/i.test(normalizedKey)) throw unsafeSource();
        if (/^(?:password|credentials?|cookies?|tokens?|raw_?capture|raw_?path|file_?path|hidden_?(?:solutions?|answers?)|solutions?|correct_?answers?|people|students?|classmates?|authors?|users?|profiles?)$/i.test(normalizedKey)) throw unsafeSource();
        if (redactor.text(key) !== key) throw unsafeSource();
        const safe = visit(entry, depth + 1, key, inner);
        // Identifiers/locators/hashes and accepted evidence must retain their exact meaning.
        if (/^locator$/u.test(key) && safe !== entry) throw unsafeSource();
        return [key, safe];
      }));
    }
    return item;
  };
  return visit(value);
}
