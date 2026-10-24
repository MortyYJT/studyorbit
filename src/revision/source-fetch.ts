import { protectRead } from '../protocol/read-privacy.js';
import { mkdir, chmod, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { hash } from '../citations/exact.js';
import { resolveDataDir } from '../config/data-dir.js';
import { createRedactor } from '../sync/redaction.js';
import { CANVAS_ORIGIN, ED_ORIGIN } from '../sync/ed-scope.js';
import { contracts, type CommandOutput } from '../protocol/contracts.js';
import { CourseworkError } from '../protocol/errors.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import { courseEvidence, materialIdentity, materialMetadata, sourceURL } from './sources.js';
import { ResidentSourceTransport } from './source-transport.js';

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export interface SourceResponse { url: string; status: number; contentType: string; body: Uint8Array; text?: string; privacyScope?: unknown }
export interface SourceTransport { read(url: string): Promise<SourceResponse> }
export class SourceFetcher {
  constructor(private readonly options: { store: SqliteRepository; directory?: string; transport?: SourceTransport }) {}
  async fetch(input: unknown): Promise<CommandOutput<'source.fetch'>> {
    const parsed = contracts['source.fetch'].input.safeParse(input);
    if (!parsed.success) throw new CourseworkError('INVALID_INPUT', 'source.fetch accepts only a course and provider URL.');
    const { courseId, url: value } = parsed.data; const url = sourceURL(value);
    const store = this.options.store;
    const course = store.loadCourse(courseId);
    if (!course) throw new CourseworkError('NOT_FOUND', 'Course not found.');
    const platform = url.origin === CANVAS_ORIGIN ? 'canvas' : 'ed';
    const path = decodeURIComponent(url.pathname);
    const externalId = (platform === 'canvas'
      ? /^\/(?:api\/v1\/)?courses\/([^/]+)\//
      : /^\/(?:au\/|api\/)?courses\/([^/]+)\//).exec(path)?.[1];
    let bound = externalId !== undefined && !!course.sources?.some(source => source.platform === platform && source.externalId === externalId);
    // Ed lesson APIs omit the course id; only a stored same-course URL can establish ownership.
    if (!externalId && platform === 'ed') {
      let cursor: string | undefined;
      do {
        const page = store.query('sourceItems', { courseId, limit: 500, cursor });
        bound = page.items.some(item => item.platform === 'ed' && !item.removed && item.kind !== 'post' && item.url === url.href);
        cursor = page.nextCursor;
      } while (!bound && cursor);
    }
    if (!bound) {
      throw new CourseworkError('INVALID_INPUT', 'Source URL does not match a trusted course mapping.');
    }
    const response = await (this.options.transport ?? new ResidentSourceTransport()).read(url.href);
    if (response.status === 401 || response.status === 403) throw new CourseworkError('AUTH_EXPIRED', 'Sign in to the provider.');
    if (response.url !== url.href || response.status < 200 || response.status >= 300) {
      throw new CourseworkError('SOURCE_UNAVAILABLE', 'Redirects and unsuccessful source responses are refused.');
    }
    if (response.body.byteLength > MAX_SOURCE_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', 'Source download exceeds 10 MiB.');
    let texts: string[]; let scope: unknown = response.privacyScope ?? {};
    const isPDF = /^application\/pdf\b/i.test(response.contentType);
    if (isPDF) {
      const document = await getDocumentProxy(new Uint8Array(response.body));
      try { texts = (await extractText(document, { mergePages: false })).text; }
      finally { await document.loadingTask.destroy(); }
    } else if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.contentType)) {
      let json: unknown;
      try { json = JSON.parse(Buffer.from(response.body).toString('utf8')); scope = { json, transport: response.privacyScope ?? {} }; }
      catch { throw new CourseworkError('SOURCE_UNAVAILABLE', 'Invalid source JSON.'); }
      const values: string[] = [];
      const walk = (value: unknown, depth = 0): void => {
        if (depth > 30 || values.length > 10000) throw new CourseworkError('LIMIT_EXCEEDED', 'Source JSON exceeds extraction bounds.');
        if (typeof value === 'string') values.push(value);
        else if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
        else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
          if (/^(?:authors?|users?|people|students?|classmates?|peers?|.*token.*|cookies?|headers|password|credentials?|.*(?:answers?|solutions?).*)$/i.test(key)) continue;
          walk(item, depth + 1);
        }
      };
      if (response.text === undefined) walk(json);
      texts = [response.text ?? values.join('\n')];
    } else if (/^text\/html\b/i.test(response.contentType) && response.text !== undefined) texts = [response.text];
    else if (/^text\/plain\b/i.test(response.contentType)) texts = [Buffer.from(response.body).toString('utf8')];
    else throw new CourseworkError('SOURCE_UNAVAILABLE', 'Unsupported source format.');
    if (texts.length > 500) throw new CourseworkError('LIMIT_EXCEEDED', 'Source has too many pages.');
    const redactor = createRedactor({ scope, output: texts });
    const safeURL = redactor.url(url.href);
    if (safeURL !== url.href) throw new CourseworkError('INVALID_INPUT', 'Source URL contains personal data.');
    const fetchedAt = new Date().toISOString(); const emptyPages: number[] = [];
    const sourceItems = texts.map((text, index) => {
      const page = isPDF ? index + 1 : undefined;
      const safe = protectRead(redactor.readText(text).trim(), scope) as string;
      if (!safe && page) emptyPages.push(page);
      if (safe.length > 100000) throw new CourseworkError('LIMIT_EXCEEDED', 'Source page text exceeds citation bounds.');
      return { id: `material-${hash([courseId, url.href, page ?? null]).slice(0, 32)}`,
        courseId, platform: url.origin === CANVAS_ORIGIN ? 'canvas' as const : 'ed' as const,
        externalId: materialIdentity(url.href, page), kind: 'material' as const, title: page ? `Material page ${page}` : 'Material',
        url: safeURL, text: safe, contentHash: hash(safe), fetchedAt };
    });
    const directory = join(this.options.directory ?? resolveDataDir(), 'materials');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Private materials directory cannot be a symlink.');
    await chmod(directory, 0o700);
    const rawPath = join(directory, `${hash(url.href)}.raw`);
    // O_NOFOLLOW prevents following a pre-existing raw-file symlink.
    const { constants } = await import('node:fs');
    await writeFile(rawPath, response.body, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode: 0o600 });
    await chmod(rawPath, 0o600);
    const old = store.query('sourceItems', { courseId, kind: 'material', limit: 500 }).items
      .filter(item => item.url === safeURL && materialMetadata(item.externalId) && !sourceItems.some(current => current.id === item.id))
      .map(item => ({ ...item, removed: true }));
    store.saveBatch({ sourceItems: [...old, ...sourceItems] });
    const evidence = new TrustedStoreEvidence(store);
    const items = await Promise.all(sourceItems.filter(item => item.text).map(item => evidence.get(item.id)));
    const snapshot = await courseEvidence(store, evidence, courseId);
    return { items, emptyPages, sourceRevision: snapshot.sourceRevision };
  }
}
