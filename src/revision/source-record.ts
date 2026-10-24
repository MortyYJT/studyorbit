import { hash } from '../citations/exact.js';
import { contracts, type CommandOutput } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import { protectRead } from '../protocol/read-privacy.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { CANVAS_ORIGIN } from '../sync/course-json.js';
import { createRedactor } from '../sync/redaction.js';
import { courseEvidence, materialIdentity, sourceURL } from './sources.js';

export const MAX_RECORDED_TEXT = 100_000;
/** Refusal messages that name their reason to the agent (see `safeError`). */
export const sourceRecordRefusals: readonly string[] = [
  'Off-origin source URLs are refused.', 'Discussion threads and replies are refused.',
  'Authentication URLs and credentials are refused.', 'Source URL does not belong to this course.',
  'Source page text exceeds 100,000 characters.',
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
    if (text.length > MAX_RECORDED_TEXT) throw new CourseworkError('LIMIT_EXCEEDED', 'Source page text exceeds 100,000 characters.');
    const redactor = createRedactor({ scope: {}, output: [title, text] });
    const safeURL = redactor.url(url.href);
    if (safeURL !== url.href) throw new CourseworkError('INVALID_INPUT', 'Source URL contains personal data.');
    const safe = protectRead(redactor.readText(text).trim(), {}) as string;
    if (safe.length > MAX_RECORDED_TEXT) throw new CourseworkError('LIMIT_EXCEEDED', 'Source page text exceeds 100,000 characters.');
    const safeTitle = (protectRead(redactor.readText(title).trim(), {}) as string) || 'Material';
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
