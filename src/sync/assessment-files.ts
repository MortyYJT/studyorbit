import { readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Assessment, SavedFile, SourceItem } from '../domain/schemas.js';
import { normalizeAssessmentKind } from '../domain/schemas.js';
import { hash } from '../citations/exact.js';
import { materialIdentity, sourceURL } from '../revision/sources.js';
import type { CommandOutput } from '../protocol/contracts.js';
import { contracts } from '../protocol/contracts.js';
import type { TrustedContext } from '../protocol/context.js';
import { AgentFacingError } from '../protocol/errors.js';
import type { SqliteRepository } from '../store/sqlite.js';
import {
  archiveCourse, courseFolderPath, decodeMhtmlHtml, htmlToText, type CourseFolderOptions,
} from './course-folder.js';

/** Per-file extraction cap (characters); the stored text is further bounded for `sources.get`. */
export const MAX_EXTRACTED_CHARS = 200_000;
/**
 * SourceItem text bound, in UTF-8 bytes of its JSON encoding. It matches `source.record` so the existing
 * `sources.get` response still fits the 64 KiB envelope.
 */
export const MAX_SOURCE_TEXT_BYTES = 60_000;
/** Room for the envelope metadata around the command's data. */
const MAX_RESPONSE_DATA_BYTES = 60 * 1024;
const MOVE_WINDOW_MS = 30 * 60_000;
const NOTHING_SAVED = (assessmentId: string) => `Nothing is saved for assessment ${JSON.stringify(assessmentId)}. Open its assignment page in Edge, save it with "Save as" as a single-file .mhtml, download the attachments, then call assessment.files with { assessmentId, saved: [file names] }. Code moves exactly those names from Downloads into the assessment folder before extracting.`;
const MISSING = (names: readonly string[]) => `Could not move from Downloads: ${summarize(names)}. Only an exact file name, a regular file and a modification time at or after this call started are moved; save them again and retry.`;

export interface AssessmentFilesOptions {
  /** Course folder and Downloads seams; tests pass a temporary root and Downloads directory. */
  folder?: CourseFolderOptions;
  /** Current time, injectable for deterministic move bounds. */
  now?: () => Date;
}

type FileKind = 'html' | 'pdf' | 'other';
interface FileResult {
  sourceItemId?: string;
  name: string;
  kind: FileKind;
  extracted: boolean;
  text?: string;
}
type FilesOutput = CommandOutput<'assessment.files'>;

/**
 * `assessment.files`: reads the deep layer of one stored assessment from the owner's course folder.
 * HTML/MHTML text is extracted and recorded as a material SourceItem linked to the assessment; PDFs and other
 * files are listed but not extracted (PDF text needs the owner's decision on a dependency). No filesystem path
 * is ever returned to the agent. When nothing is saved, the command tells the agent how to save the page and
 * call it again with `saved` names, which are moved from Downloads under the same rules as the course folder.
 */
export class AssessmentFiles {
  constructor(private readonly store: SqliteRepository, private readonly options: AssessmentFilesOptions = {}) {}

  files(input: unknown, context: Pick<TrustedContext, 'conversationId' | 'setAuditReferences'> = {}): FilesOutput {
    const parsed = contracts['assessment.files'].input.safeParse(input);
    if (!parsed.success) throw new AgentFacingError('INVALID_INPUT', 'assessment.files accepts an assessmentId and optional saved file names.');
    const { assessmentId, saved } = parsed.data;
    const assessment = this.store.loadAssessment(assessmentId);
    if (!assessment) throw new AgentFacingError('NOT_FOUND', 'Assessment not found.');
    if (effectiveKind(this.store, assessment) === 'exam') {
      throw new AgentFacingError('INVALID_INPUT', 'assessment.files is unavailable for an exam; exams have no Start flow.');
    }
    const course = this.store.loadCourse(assessment.courseId);
    if (!course) throw new AgentFacingError('NOT_FOUND', 'Course not found.');
    context.setAuditReferences?.({ courseId: course.id, assessmentId: assessment.id, level: 0 });

    const now = this.now();
    const folderCourse = { id: course.id, code: course.code, name: course.name, term: course.term };
    const missing: string[] = [];
    if (saved?.length) {
      const result = archiveCourse({
        store: this.store,
        course: folderCourse,
        jobStartedAt: this.moveLowerBound(context.conversationId, now),
        stages: { 'assignments.assessment-files': { files: saved } },
        assessmentIdFor: key => key === 'assessment-files' ? assessment.id : undefined,
        options: { ...this.options.folder, now: () => now },
      });
      missing.push(...result.missing);
    }

    let courseDirectory: string;
    try { courseDirectory = courseFolderPath(folderCourse, this.options.folder ?? {}); }
    catch { courseDirectory = ''; }
    const assessmentUrl = this.assessmentUrl(assessment.id);
    const files = this.currentRecords(assessment.id).map(record => this.extract(record, assessment, courseDirectory, assessmentUrl, now));
    return this.bounded(files, missing, assessment.id);
  }

  private now(): Date {
    return this.options.now?.() ?? this.options.folder?.now?.() ?? this.options.folder?.clock?.() ?? new Date();
  }

  /** The conversation start when known, else 30 minutes before this call. */
  private moveLowerBound(conversationId: string | undefined, now: Date): Date {
    const conversation = conversationId === undefined ? undefined : this.store.readConversations().find(row => row.id === conversationId);
    const started = conversation === undefined ? Number.NaN : Date.parse(conversation.createdAt);
    return Number.isNaN(started) ? new Date(now.getTime() - MOVE_WINDOW_MS) : new Date(started);
  }

  private currentRecords(assessmentId: string): SavedFile[] {
    return this.store.listSavedFilesForAssessment(assessmentId).filter(record => record.supersededAt === undefined);
  }

  private assessmentUrl(assessmentId: string): string | undefined {
    const links = this.store.readAssessmentLinks(assessmentId);
    for (let index = links.length - 1; index >= 0; index--) {
      const source = this.store.loadSourceItem(links[index]!.sourceItemId);
      if (source?.platform !== 'canvas' || !source.url) continue;
      try { return sourceURL(source.url).href; } catch { continue; }
    }
    return undefined;
  }

  private extract(record: SavedFile, assessment: Assessment, courseDirectory: string, url: string | undefined,
    now: Date): FileResult {
    const name = basename(record.path);
    const extension = extname(name).toLowerCase();
    const kind: FileKind = ['.mhtml', '.mht', '.html', '.htm'].includes(extension) ? 'html'
      : extension === '.pdf' ? 'pdf' : 'other';
    if (kind !== 'html') return { name, kind, extracted: false };
    try {
      const path = recordPath(record, courseDirectory);
      if (!path) return { name, kind, extracted: false };
      const bytes = readFileSync(path);
      const html = extension === '.mhtml' || extension === '.mht' ? decodeMhtmlHtml(bytes) : bytes.toString('utf8');
      const text = htmlToText(html).slice(0, MAX_EXTRACTED_CHARS).trim();
      if (!text) return { name, kind, extracted: false };
      const stored = capEncodedText(text, MAX_SOURCE_TEXT_BYTES);
      if (!stored) return { name, kind, extracted: false };
      const sourceItemId = `material-${hash(['assessment-file', assessment.id, record.fingerprint]).slice(0, 32)}`;
      const item: SourceItem = {
        id: sourceItemId, platform: 'manual',
        externalId: materialIdentity(`coursework:assessment-file:${assessment.id}:${record.fingerprint}`),
        courseId: assessment.courseId, kind: 'material', title: name, ...(url ? { url } : {}),
        text: stored, contentHash: hash(stored), fetchedAt: now.toISOString(),
      };
      // Same fingerprint keeps the same id, so a re-call upserts one SourceItem and appends no second link.
      const linked = this.store.currentAssessmentLinks(assessment.id).some(link => link.sourceItemId === sourceItemId);
      this.store.saveBatch({ sourceItems: [item], ...(linked ? {} : {
        assessmentLinks: [{ assessmentId: assessment.id, sourceItemId, origin: 'agent' as const, at: now.toISOString() }],
      }) });
      return { sourceItemId, name, kind, extracted: true, text: stored };
    } catch {
      return { name, kind, extracted: false };
    }
  }

  /** Trim file texts until the command data fits the shared 64 KiB envelope; name what to read with `sources.get`. */
  private bounded(files: FileResult[], missing: readonly string[], assessmentId: string): FilesOutput {
    const nothingSaved = files.length === 0;
    const base = [nothingSaved ? NOTHING_SAVED(assessmentId) : undefined, missing.length ? MISSING(missing) : undefined]
      .filter((value): value is string => value !== undefined).join(' ');
    const textual = files.filter((file): file is FileResult & { sourceItemId: string; text: string } =>
      file.sourceItemId !== undefined && file.text !== undefined);
    let visible = files.map(withoutText);
    const omitted = new Set(textual.map(file => file.sourceItemId));
    if (!fits(compose(visible, omitted, base, nothingSaved))) {
      // Even the file names and instructions do not fit; keep the instructions and drop trailing names.
      while (visible.length > 1 && !fits(compose(visible, omitted, base, nothingSaved))) visible = visible.slice(0, -1);
    }
    for (const file of textual) {
      const index = visible.findIndex(candidate => candidate.sourceItemId === file.sourceItemId);
      if (index < 0) continue;
      const full = [...visible];
      full[index] = { ...full[index]!, text: file.text };
      const withoutId = new Set(omitted); withoutId.delete(file.sourceItemId);
      if (fits(compose(full, withoutId, base, nothingSaved))) {
        visible = full; omitted.delete(file.sourceItemId);
        continue;
      }
      // Return the first part of this text, then stop; later files stay named for `sources.get`.
      let low = 0; let high = file.text.length; let best = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = [...visible];
        candidate[index] = { ...candidate[index]!, text: file.text.slice(0, middle) };
        if (fits(compose(candidate, omitted, base, nothingSaved))) { best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (best > 0) {
        visible[index] = { ...visible[index]!, text: file.text.slice(0, best) };
      }
      break;
    }
    return compose(visible, omitted, base, nothingSaved);
  }
}

function compose(files: FileResult[], omitted: ReadonlySet<string>, base: string, nothingSaved: boolean): FilesOutput {
  const instructions = [base, omitted.size ? omittedInstruction([...omitted]) : undefined]
    .filter((value): value is string => value !== undefined && value.length > 0).join(' ');
  return contracts['assessment.files'].output.parse({
    files,
    ...(nothingSaved ? { nothing_saved: true } : {}),
    ...(instructions ? { instructions } : {}),
  });
}

function fits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RESPONSE_DATA_BYTES;
}

function omittedInstruction(ids: readonly string[]): string {
  const shown = summarize(ids);
  return `Some text is omitted to keep the response within 64 KiB; read the full text of SourceItem(s) ${shown} with sources.get { "sourceItemId": "<id>" }.`;
}

function summarize(values: readonly string[]): string {
  const shown: string[] = []; let length = 0;
  for (const value of values) {
    if (shown.length >= 10 || length + value.length > 500) break;
    shown.push(value); length += value.length + 2;
  }
  return `${shown.join(', ')}${shown.length < values.length ? ` and ${values.length - shown.length} more` : ''}`;
}

function withoutText(file: FileResult): FileResult {
  const { text: _text, ...rest } = file;
  return rest;
}

function recordPath(record: SavedFile, courseDirectory: string): string | undefined {
  if (isAbsolute(record.path)) return record.path;
  if (!courseDirectory) return undefined;
  const resolved = resolve(courseDirectory, record.path);
  const within = relative(courseDirectory, resolved);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined;
  return resolved;
}

/** Largest prefix whose JSON encoding fits `maxBytes`, without splitting an encoded character sequence. */
function capEncodedText(text: string, maxBytes: number): string {
  const encoded = (value: string) => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
  if (encoded(text) <= maxBytes) return text;
  let low = 0; let high = text.length; let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (encoded(text.slice(0, middle)) <= maxBytes) { best = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return text.slice(0, best).trim();
}

function effectiveKind(store: SqliteRepository, assessment: Assessment): unknown {
  const rows = store.readAnnotations('assessment', assessment.id).filter(row => row.field === 'kind');
  const row = rows.filter(row => row.origin === 'owner').at(-1) ?? rows.filter(row => row.origin === 'agent').at(-1);
  return row ? normalizeAssessmentKind(row.value) : assessment.kind;
}
