import { hash } from '../citations/exact.js';
import { contracts, type CommandOutput } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import { protectRead } from '../protocol/read-privacy.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { CANVAS_ORIGIN } from '../sync/course-json.js';
import { createRedactor } from '../sync/redaction.js';
import { courseEvidence, materialIdentity, sourceURL } from './sources.js';

/**
 * Bound on a recorded page's text, in UTF-8 bytes of its JSON encoding, so `sources.get` of the largest page still fits
 * the 64 KiB envelope with a 2,048-character URL and the other evidence fields (tested in source-record.test.ts).
 */
export const MAX_RECORDED_BYTES = 60_000;
const TOO_LARGE = 'Source page text exceeds 60,000 bytes (UTF-8, JSON-encoded); record it in parts, adding #part-2, #part-3 and so on to the URL.';
const UNSAFE = 'The text contains something the privacy check cannot make safe; remove other people\'s names or identifiers and record again.';
const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
/** Refusal messages that name their reason to the agent (see `safeError`). */
export const sourceRecordRefusals: readonly string[] = [
  'Off-origin source URLs are refused.', 'Discussion threads and replies are refused.',
  'Authentication URLs and credentials are refused.', 'Source URL does not belong to this course.',
  TOO_LARGE, UNSAFE,
];

/**
 * `source.record`: the agent supplies a page's text it read in the owner's Edge (#187, partly overturning #109).
 * Code checks the origin and course binding, refuses discussion threads, bounds and redacts the text, and stores it
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
    const path = decodeURIComponent(url.pathname);
    const externalId = (platform === 'canvas' ? /^\/(?:api\/v1\/)?courses\/([^/]+)(?:\/|$)/ : /^\/(?:au\/|api\/)?courses\/([^/]+)(?:\/|$)/).exec(path)?.[1];
    // The URL must name one of this course's Canvas or Ed course ids; nothing else establishes ownership.
    if (!externalId || !course.sources?.some(source => source.platform === platform && source.externalId === externalId)) {
      throw new CourseworkError('INVALID_INPUT', 'Source URL does not belong to this course.');
    }
    if (encodedBytes(text) > MAX_RECORDED_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', TOO_LARGE);
    const redactor = createRedactor({ scope: {}, output: [title, text] });
    const safeURL = redactor.url(url.href);
    if (safeURL !== url.href) throw new CourseworkError('INVALID_INPUT', 'Source URL contains personal data.');
    // Format characters (soft hyphens, zero-width spaces) are dropped before redaction and hashing.
    const plain = text.replace(/[^\P{C}\t\n]/gu, '');
    const copy = { agentCopy: true } as const;
    let safe: string; let safeTitle: string;
    try {
      safe = protectRead(redactor.readText(plain, copy).trim(), {}, copy) as string;
      safeTitle = (protectRead(redactor.readText(title.replace(/[^\P{C}]/gu, ''), copy).trim(), {}, copy) as string) || 'Material';
    } catch (error) {
      if (error instanceof CourseworkError && error.code === 'SOURCE_UNAVAILABLE') throw new CourseworkError('INVALID_INPUT', UNSAFE);
      throw error;
    }
    if (encodedBytes(safe) > MAX_RECORDED_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', TOO_LARGE);
    const id = `material-${hash([courseId, url.href, page ?? null]).slice(0, 32)}`;
    // Same URL and page keep the same id, so recording again replaces the text and its hash.
    this.store.saveSourceItem({ id, courseId, platform, externalId: materialIdentity(url.href, page), kind: 'material',
      title: safeTitle, url: safeURL, text: safe, contentHash: hash(safe), fetchedAt: new Date().toISOString(), copiedBy: 'agent' });
    const evidence = new TrustedStoreEvidence(this.store);
    const item = safe ? await evidence.get(id) : undefined;
    const snapshot = await courseEvidence(this.store, evidence, courseId);
    return { sourceItemId: id, empty: !safe, locator: page ? `page:${page}` : 'text', ...(page ? { page } : {}),
      sourceHash: item?.sourceHash ?? hash(safe), copiedBy: 'agent', sourceRevision: snapshot.sourceRevision };
  }
}
