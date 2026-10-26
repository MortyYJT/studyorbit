import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SavedFile } from '../domain/schemas.js';

/** Small filesystem seams so tests can run wholly inside a temporary directory. */
export interface CourseFolderOptions {
  /** Base directory that holds `<School> <YYSn>`; defaults to COURSEWORK_FILES or ~/Desktop. */
  root?: string;
  /** Where the browser/agent leaves downloaded files; defaults to ~/Downloads. */
  downloadsDir?: string;
  /** Alias for `downloadsDir`. */
  downloads?: string;
  /** Alias for `downloadsDir`. */
  downloadsDirectory?: string;
  /** Current time, injectable for deterministic saved/superseded dates. */
  now?: () => Date;
  /** Alias for `now`. */
  clock?: () => Date;
  /** Environment source for COURSEWORK_FILES (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Home directory used by the defaults (tests pass a temporary home). */
  homeDir?: string;
}

export interface CourseFolderCourse {
  id: string;
  code: string;
  name?: string;
  term: string;
}

/** The store methods the archive needs; a fake only has to provide these. */
export interface CourseFolderStore {
  saveSavedFile(value: SavedFile): void;
  listSavedFiles(courseId: string): SavedFile[];
  listSavedFilesForAssessment?(assessmentId: string): SavedFile[];
  loadAssessment?(id: string): { id: string; name: string } | undefined;
}

export interface MarkOpenedStore {
  loadSavedFile(id: string): SavedFile | undefined;
  saveSavedFile(value: SavedFile): void;
}

export interface ArchiveCourseInput {
  store: CourseFolderStore;
  course: CourseFolderCourse;
  /** ISO instant or Date: only downloads modified at or after this are moved. */
  jobStartedAt: string | Date;
  /** One course's stages: `assignments.<target>` and `materials`. */
  stages: Record<string, unknown>;
  /** Maps a Canvas assignment target to the stored Assessment id, if it exists yet. */
  assessmentIdFor(target: string): string | undefined;
  options?: CourseFolderOptions;
}

export interface ArchiveResult {
  /** Absolute destination paths of files moved into the course folder. */
  moved: string[];
  /** Reported files that were absent, too old, unsafe, or whose assessment was unresolved. */
  missing: string[];
  /** Absolute destination paths whose previous version was kept with a date suffix (update notice). */
  updated: string[];
}

/** `2026:S2` -> `26S2`, `2026:SUMMER` -> `26Summer`. */
export function termFolderName(term: string): string {
  const match = /^(\d{4}):(S1|S2|SUMMER|WINTER)$/.exec(term);
  if (!match) throw new Error(`Unsupported course term: ${term}`);
  const season = match[2]!;
  return `${match[1]!.slice(2)}${season === 'SUMMER' ? 'Summer' : season === 'WINTER' ? 'Winter' : season}`;
}

/** Replace path separators, reserved characters, control characters and unsafe edge dots/spaces. */
export function sanitizePathSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F-\u009F]/g, '_')
    .replace(/^\.+/, dots => '_'.repeat(dots.length))
    .replace(/[ .]+$/, chars => '_'.repeat(chars.length));
  return cleaned || '_';
}

/** Absolute path of one course's folder inside `<root>/UniMelb <YYSn>/`. */
export function courseFolderPath(course: CourseFolderCourse, options: CourseFolderOptions = {}): string {
  const name = course.name?.trim();
  return join(baseRoot(options), `UniMelb ${termFolderName(course.term)}`, sanitizePathSegment(name || course.code));
}

/** Alias used by callers that think of the course folder as the archive root. */
export const courseFolderRoot = courseFolderPath;

/** SHA-256 hex of a file; `.mhtml` fingerprints only the normalized decoded HTML body. */
export function fingerprintFile(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.mhtml' || extension === '.mht') {
    return createHash('sha256').update(normalizeMhtml(readFileSync(path)), 'utf8').digest('hex');
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Alias that reads naturally in callers. */
export const fileFingerprint = fingerprintFile;

/** Set `openedAt` so the update notice for a superseded file disappears. */
export function markOpened(store: MarkOpenedStore, savedFileId: string, now: Date | string): SavedFile {
  const saved = store.loadSavedFile(savedFileId);
  if (!saved) throw new Error(`Saved file not found: ${savedFileId}`);
  const opened = { ...saved, openedAt: typeof now === 'string' ? now : now.toISOString() };
  store.saveSavedFile(opened);
  return opened;
}

/** Move the files of one course's stages into its folder and record their fingerprints. */
export function archiveCourse(input: ArchiveCourseInput): ArchiveResult {
  const { store, course } = input;
  const options = input.options ?? {};
  const now = (options.now ?? options.clock ?? (() => new Date()))();
  const savedAt = now.toISOString();
  const jobStartedAt = typeof input.jobStartedAt === 'string' ? Date.parse(input.jobStartedAt) : input.jobStartedAt.getTime();
  if (Number.isNaN(jobStartedAt)) throw new Error(`Invalid job start time: ${String(input.jobStartedAt)}`);
  const downloads = resolve(expandHome(options.downloadsDir ?? options.downloads ?? options.downloadsDirectory ?? join(home(options), 'Downloads'), home(options)));
  const courseDirectory = courseFolderPath(course, options);
  const moved: string[] = [];
  const missing: string[] = [];
  const updated: string[] = [];

  const targets: { assessmentId?: string; folder: string; stage: unknown; unresolved: boolean }[] = [];
  for (const [key, stage] of Object.entries(input.stages)) {
    if (!key.startsWith('assignments.')) continue;
    const target = key.slice('assignments.'.length);
    const assessmentId = input.assessmentIdFor(target);
    const assessment = assessmentId === undefined ? undefined : store.loadAssessment?.(assessmentId);
    if (assessment) {
      targets.push({
        assessmentId: assessment.id,
        folder: join('assessments', sanitizePathSegment(assessment.name?.trim() || target)),
        stage,
        unresolved: false,
      });
    } else {
      targets.push({ folder: join('assessments', sanitizePathSegment(target)), stage, unresolved: true });
    }
  }
  if ('materials' in input.stages) {
    targets.push({ folder: 'materials', stage: input.stages.materials, unresolved: false });
  }

  for (const target of targets) {
    for (const name of stageFiles(target.stage)) {
      if (!isSafeName(name)) {
        missing.push(name);
        continue;
      }
      const source = join(downloads, name);
      let sourceStat: ReturnType<typeof statSync>;
      try {
        sourceStat = statSync(source);
      } catch {
        missing.push(name);
        continue;
      }
      if (!sourceStat.isFile() || sourceStat.mtimeMs < jobStartedAt) {
        missing.push(name);
        continue;
      }

      const relativePath = join(target.folder, name);
      const destination = join(courseDirectory, relativePath);
      try {
        mkdirSync(dirname(destination), { recursive: true });
        const fingerprint = fingerprintFile(source);
        const existing = currentRecord(store, course.id, target.assessmentId, relativePath, courseDirectory);
        if (existing) {
          if (existing.fingerprint === fingerprint) {
            // Same page: keep the record (and its notice state), replace the bytes.
            replaceFile(source, destination);
          } else {
            supersede(store, existing, courseDirectory, savedAt);
            // The old current file normally occupied this path; if it did not, keep any untracked file too.
            if (existsSync(destination)) preserveExisting(destination, savedAt);
            replaceFile(source, destination);
            store.saveSavedFile({
              id: randomUUID(),
              courseId: course.id,
              ...(target.assessmentId === undefined ? {} : { assessmentId: target.assessmentId }),
              path: relativePath,
              fingerprint,
              savedAt,
            });
            updated.push(destination);
          }
        } else {
          // Never remove an owner's file: an untracked name collision is kept beside the new file.
          if (existsSync(destination)) preserveExisting(destination, savedAt);
          replaceFile(source, destination);
          store.saveSavedFile({
            id: randomUUID(),
            courseId: course.id,
            ...(target.assessmentId === undefined ? {} : { assessmentId: target.assessmentId }),
            path: relativePath,
            fingerprint,
            savedAt,
          });
        }
        moved.push(destination);
        if (target.unresolved) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
  }

  return { moved, missing, updated };
}

function home(options: CourseFolderOptions): string {
  return options.homeDir ?? homedir();
}

function baseRoot(options: CourseFolderOptions): string {
  if (options.root !== undefined) return resolve(expandHome(options.root, home(options)));
  const configured = (options.env ?? process.env).COURSEWORK_FILES?.trim();
  if (configured) return resolve(expandHome(configured, home(options)));
  return join(home(options), 'Desktop');
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === '~') return homeDirectory;
  if (path.startsWith('~/')) return join(homeDirectory, path.slice(2));
  return path;
}

function isSafeName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/]/.test(name) && basename(name) === name;
}

function stageFiles(stage: unknown): string[] {
  if (!stage || typeof stage !== 'object') return [];
  const files = (stage as { files?: unknown }).files;
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string' && file.length > 0) : [];
}

function currentRecord(store: CourseFolderStore, courseId: string, assessmentId: string | undefined, relativePath: string,
  courseDirectory: string): SavedFile | undefined {
  const records = assessmentId !== undefined
    ? store.listSavedFilesForAssessment?.(assessmentId) ?? store.listSavedFiles(courseId).filter(record => record.assessmentId === assessmentId)
    : store.listSavedFiles(courseId);
  return records.find(record => record.supersededAt === undefined && sameRecordPath(record.path, relativePath, courseDirectory));
}

/** Records written by this module are relative; accept an older absolute path for the same file too. */
function sameRecordPath(saved: string, relativePath: string, courseDirectory: string): boolean {
  return saved === relativePath
    || (isAbsolute(saved) && resolve(saved) === resolve(courseDirectory, relativePath));
}

/** Rename the old current file to `<stem> (<saved date>)<ext>` (or ` 2`, ` 3`, …) and mark it superseded. */
function supersede(store: CourseFolderStore, record: SavedFile, courseDirectory: string, supersededAt: string): void {
  const previous = isAbsolute(record.path) ? record.path : join(courseDirectory, record.path);
  let path = record.path;
  if (existsSync(previous)) {
    const renamed = availableSuffixedPath(previous, melbourneDate(record.savedAt));
    renameSync(previous, renamed);
    path = isAbsolute(record.path) ? renamed : relative(courseDirectory, renamed);
  }
  store.saveSavedFile({ ...record, path, supersededAt });
}

/** Keep an untracked file that a first save would otherwise overwrite. */
function preserveExisting(destination: string, at: string): void {
  renameSync(destination, availableSuffixedPath(destination, melbourneDate(at)));
}

function availableSuffixedPath(path: string, date: string): string {
  const extension = extname(path);
  const stem = basename(path, extension);
  const directory = dirname(path);
  let candidate = join(directory, `${stem} (${date})${extension}`);
  for (let suffix = 2; existsSync(candidate); suffix++) {
    candidate = join(directory, `${stem} (${date} ${suffix})${extension}`);
  }
  return candidate;
}

/** Melbourne calendar date (`YYYY-MM-DD`) of an instant, used only for the kept copy's suffix. */
function melbourneDate(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);
}

/** Move within one filesystem; on a cross-device or locked rename, copy then remove the Downloads original. */
function replaceFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EACCES') throw error;
    copyFileSync(source, destination);
    unlinkSync(source);
  }
}

function normalizeMhtml(bytes: Buffer): string {
  // Headers are ASCII; latin1 keeps every body byte unchanged until its transfer encoding is decoded.
  const raw = bytes.toString('latin1');
  const headerEnd = /\r?\n\r?\n/.exec(raw);
  const topHeaders = parseHeaders(headerEnd ? raw.slice(0, headerEnd.index) : raw);
  const topBody = headerEnd ? raw.slice(headerEnd.index + headerEnd[0].length) : raw;
  const boundary = boundaryOf(topHeaders['content-type']);
  if (!boundary) {
    const type = (topHeaders['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
    return normalizeHtml(type === 'text/html' ? decodePart(topHeaders, topBody) : raw);
  }
  const parts = multipartSegments(raw, boundary);
  for (const part of parts) {
    const headers = part.headers;
    const type = (headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (type !== 'text/html') continue;
    return normalizeHtml(decodePart(headers, part.body));
  }
  return normalizeHtml(raw);
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

function multipartSegments(raw: string, boundary: string): MimePart[] {
  const delimiter = `--${boundary}`;
  const closing = `${delimiter}--`;
  const parts: MimePart[] = [];
  let current: string[] | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/[ \t]+$/, '');
    if (trimmed === delimiter) {
      if (current) parts.push(splitPart(current.join('\n')));
      current = [];
      continue;
    }
    if (trimmed === closing) {
      if (current) parts.push(splitPart(current.join('\n')));
      current = undefined;
      break;
    }
    if (current) current.push(line);
  }
  if (current && current.length) parts.push(splitPart(current.join('\n')));
  return parts;
}

function splitPart(part: string): MimePart {
  const separator = /\r?\n\r?\n/.exec(part);
  if (!separator) return { headers: parseHeaders(part), body: '' };
  return {
    headers: parseHeaders(part.slice(0, separator.index)),
    body: part.slice(separator.index + separator[0].length),
  };
}

function decodePart(headers: Record<string, string>, body: string): string {
  const encoding = (headers['content-transfer-encoding'] ?? '').trim().toLowerCase();
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(headers['content-type'] ?? '')?.[1]?.toLowerCase() ?? 'utf-8';
  let bytes: Buffer;
  if (encoding === 'quoted-printable') bytes = decodeQuotedPrintable(body);
  else if (encoding === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else bytes = Buffer.from(body, 'latin1');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '=') {
      if (text[index + 1] === '\r' && text[index + 2] === '\n') { index += 2; continue; }
      if (text[index + 1] === '\n') { index += 1; continue; }
      const hex = text.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    out.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

function normalizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    // ISO 8601 date-times, with or without a zone.
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi, '')
    // Canvas rendered date-times such as "26 Oct 2026 at 10:15".
    .replace(/\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:\d{4}\s+)?at\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '');
}
