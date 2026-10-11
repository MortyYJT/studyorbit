import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SourceItemSchema, type SourceItem } from '../domain/schemas.js';
import { createRedactor, unsafeSource } from './redaction.js';
/** Both adapters publish through this default-on boundary; returned values also feed event snapshots. */
export function redactNormalizedSources(provider: 'canvas' | 'ed', input: unknown, scope: unknown, rules?: unknown): SourceItem[] {
  const redactor = createRedactor(scope, rules);
  const parsed = z.array(SourceItemSchema.strict()).max(5000).safeParse(input);
  if (!parsed.success) throw unsafeSource();
  const identity = new RegExp(`^${provider}:(?:[a-f0-9]{64}|[1-9]\\d*(?::[1-9]\\d*){3})$`);
  return parsed.data.map(source => {
    if (source.platform !== provider || !identity.test(source.id)
      || source.courseId !== undefined && !new RegExp(`^${provider}:[a-f0-9]{64}$`).test(source.courseId)
      || !/^(?:[a-z_]+:)*(?:[1-9]\d*)(?::[1-9]\d*)*$/.test(source.externalId)) throw unsafeSource();
    const title = redactor.text(source.title); const text = redactor.text(source.text);
    let url: string | undefined;
    try { url = source.url === undefined ? undefined : new URL(redactor.text(source.url)).href; }
    catch { throw unsafeSource(); }
    const contentHash = createHash('sha256').update(JSON.stringify([source.kind, title, text, url ?? null])).digest('hex');
    const safe = SourceItemSchema.safeParse({ ...source, title, text, url, contentHash });
    if (!safe.success) throw unsafeSource();
    return safe.data;
  });
}
