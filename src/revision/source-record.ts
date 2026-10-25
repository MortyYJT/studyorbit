import { hash } from '../citations/exact.js';
import { contracts, type CommandOutput } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { CANVAS_ORIGIN } from '../sync/course-json.js';
import { courseEvidence, materialIdentity, sourceURL } from './sources.js';

/**
 * Bound on a recorded page's text, in UTF-8 bytes of its JSON encoding, so `sources.get` of the largest page still fits
 * the 64 KiB envelope with a 2,048-character URL and the other evidence fields (tested in source-record.test.ts).
 */
export const MAX_RECORDED_BYTES = 60_000;
const TOO_LARGE = 'Source page text exceeds 60,000 bytes (UTF-8, JSON-encoded); record it in parts, adding #part-2, #part-3 and so on to the URL.';
const ANNOUNCEMENTS = 'Announcements are refused like discussions, because they can carry replies.';
const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
/** Refusal messages that name their reason to the agent (see `safeError`). */
export const sourceRecordRefusals: readonly string[] = [
  'Off-origin source URLs are refused.', 'Discussion threads and replies are refused.',
  'Authentication URLs and credentials are refused.', 'Source URL does not belong to this course.',
  TOO_LARGE, ANNOUNCEMENTS,
];

/**
 * `source.record`: the agent supplies a page's text it read in the owner's Edge (#187, partly overturning #109).
 * Code checks the origin and course binding, refuses discussion threads, bounds and normalizes the text, and stores it
 * as an agent-copied material. A citation then shows that a quote is in the recorded text, not that the page says it.
 */
export class SourceRecorder {
  constructor(private readonly store: SqliteRepository) {}
  async record(input: unknown): Promise<CommandOutput<'source.record'>> {
    const parsed = contracts['source.record'].input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'source.record accepts a course, provider URL, title, text and optional page.');
    const { courseId, url: value, title, text, page } = parsed.data;
    const url = sourceURL(value);
    const course = this.store.loadCourse(courseId);
    if (!course) throw new CourseworkError('NOT_FOUND', 'Course not found.');
    const platform = url.origin === CANVAS_ORIGIN ? 'canvas' as const : 'ed' as const;
    // Bind on the raw path: decoding first would let `courses/1%2F..%2Fcourses%2F99` pass as course 1.
    const path = url.pathname;
    // Announcements can carry replies from classmates, so they are refused like discussions.
    // Matched on the decoded path too, so `%61nnouncements` cannot slip past; undecodable paths are refused.
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { throw new CourseworkError('INVALID_INPUT', ANNOUNCEMENTS); }
    if (platform === 'canvas' && [path, decoded].some(value => /^\/(?:api\/v1\/)?courses\/[^/]+\/announcements(?:\/|$)/i.test(value))) throw new CourseworkError('INVALID_INPUT', ANNOUNCEMENTS);
    const externalId = (platform === 'canvas' ? /^\/(?:api\/v1\/)?courses\/([^/]+)(?:\/|$)/ : /^\/(?:au\/|api\/)?courses\/([^/]+)(?:\/|$)/).exec(path)?.[1];
    // The URL must name one of this course's Canvas or Ed course ids; nothing else establishes ownership.
    if (!externalId || !course.sources?.some(source => source.platform === platform && source.externalId === externalId)) {
      throw new CourseworkError('INVALID_INPUT', 'Source URL does not belong to this course.');
    }
    if (encodedBytes(text) > MAX_RECORDED_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', TOO_LARGE);
    // Normalize copied text and remove invisible format/control characters before hashing (#191).
    const safe = text.normalize('NFKC').replace(/[^\P{C}\t\n]/gu, '').trim();
    const safeTitle = title.normalize('NFKC').replace(/[^\P{C}]/gu, '').trim() || 'Material';
    if (encodedBytes(safe) > MAX_RECORDED_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', TOO_LARGE);
    const id = `material-${hash([courseId, url.href, page ?? null]).slice(0, 32)}`;
    // Same URL and page keep the same id, so recording again replaces the text and its hash.
    this.store.saveSourceItem({ id, courseId, platform, externalId: materialIdentity(url.href, page), kind: 'material',
      title: safeTitle, url: url.href, text: safe, contentHash: hash(safe), fetchedAt: new Date().toISOString(), copiedBy: 'agent' });
    const evidence = new TrustedStoreEvidence(this.store);
    const item = safe ? await evidence.get(id) : undefined;
    const snapshot = await courseEvidence(this.store, evidence, courseId);
    return { sourceItemId: id, empty: !safe, locator: page ? `page:${page}` : 'text', ...(page ? { page } : {}),
      sourceHash: item?.sourceHash ?? hash(safe), copiedBy: 'agent', sourceRevision: snapshot.sourceRevision };
  }
}
