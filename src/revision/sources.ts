import { hash } from '../citations/exact.js';
import { CANVAS_ORIGIN, ED_ORIGIN } from '../sync/course-json.js';
import type { CommandOutput } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import type { SqliteRepository } from '../store/sqlite.js';
import type { TrustedStoreEvidence } from '../protocol/reads.js';

/** Validate a Canvas or Ed page URL: provider origin only, no discussion threads, no authentication or credential URLs. */
export function sourceURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CourseworkError('INVALID_INPUT', 'A provider URL is required.'); }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname + url.search + url.hash);
    for (let i = 0; i < 4 && /%[a-f0-9]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded);
  } catch { throw new CourseworkError('INVALID_INPUT', 'Invalid source URL encoding.'); }
  if (![CANVAS_ORIGIN, ED_ORIGIN].includes(url.origin)) throw new CourseworkError('INVALID_INPUT', 'Off-origin source URLs are refused.');
  if (/^\/(?:api\/v1\/|api\/|au\/)?(?:courses\/[^/]+\/)?(?:discussion(?:_topics|s)?|threads?|replies)(?:\/|[?#]|$)/i.test(decoded)) {
    throw new CourseworkError('INVALID_INPUT', 'Discussion threads and replies are refused.');
  }
  // Authentication words count only as whole path segments (so `pages/tokenizers` is a page); queries and fragments
  // that mention credentials are refused outright.
  const path = decoded.split(/[?#]/, 1)[0]!;
  const rest = decoded.slice(path.length);
  if (url.username || url.password || /%[a-f0-9]{2}|\\/i.test(decoded)
    || path.split('/').some(segment => /^(?:auth|oauth|authorize|login|logout|sso|saml|tokens?|passwords?|credentials?)$/i.test(segment))
    || /token|password|credential/i.test(rest)) {
    throw new CourseworkError('INVALID_INPUT', 'Authentication URLs and credentials are refused.');
  }
  return url;
}
/** Explicit versioned page metadata uses the existing externalId column; no schema migration. */
export function materialIdentity(url: string, page?: number): string {
  return JSON.stringify({ version: 1, kind: 'fetched-material', urlHash: hash(url), locator: page ? `page:${page}` : 'text', ...(page ? { page } : {}) });
}
export function materialMetadata(externalId: string): { locator: string; page?: number } | undefined {
  try {
    const data = JSON.parse(externalId);
    if (data.version !== 1 || data.kind !== 'fetched-material' || typeof data.urlHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.urlHash)) return undefined;
    if (data.page !== undefined && (!Number.isSafeInteger(data.page) || data.page < 1 || data.locator !== `page:${data.page}`)) return undefined;
    if (data.page === undefined && data.locator !== 'text') return undefined;
    return { locator: data.locator, ...(data.page ? { page: data.page as number } : {}) };
  } catch { return undefined; }
}
/** Synchronous snapshot so publication can recheck it without yielding its SQLite write lock. */
export function courseEvidenceSnapshot(store: SqliteRepository, evidence: TrustedStoreEvidence, courseId: string) {
  if (!store.loadCourse(courseId)) throw new CourseworkError('NOT_FOUND', 'Course not found.');
  const sources: CommandOutput<'sources.get'>[] = [];
  let cursor: string | undefined;
  do {
    const page = store.query('sourceItems', { courseId, limit: 500, cursor });
    for (const item of page.items) {
      if (item.removed || !item.text.trim() || item.kind === 'post') continue;
      if (item.url) { try { sourceURL(item.url); } catch { continue; } }
      try { sources.push(evidence.getSync(item.id)); }
      catch (error) { if (!(error instanceof CourseworkError) || error.code !== 'SOURCE_UNAVAILABLE') throw error; }
    }
    cursor = page.nextCursor;
  } while (cursor);
  if (sources.length > 500) throw new CourseworkError('LIMIT_EXCEEDED', 'Too many sources in the course evidence snapshot.');
  return { target: { courseId }, sources, sourceRevision: hash(sources.map(s => [s.sourceItemId, s.sourceHash, s.locator])) };
}
export async function courseEvidence(store: SqliteRepository, evidence: TrustedStoreEvidence, courseId: string) {
  return courseEvidenceSnapshot(store, evidence, courseId);
}
