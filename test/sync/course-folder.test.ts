import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedFile } from '../../src/domain/schemas.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import {
  archiveCourse, courseFolderPath, fingerprintFile, hasUpdateNotice, markOpened, sanitizePathSegment, termFolderName,
  type CourseFolderStore,
} from '../../src/sync/course-folder.js';

const fsControl = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((from: string, to: string) => void),
  renames: [] as { from: string; to: string }[],
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      fsControl.renames.push({ from, to });
      fsControl.beforeRename?.(from, to);
      return actual.renameSync(from, to);
    },
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  fsControl.beforeRename = undefined;
  fsControl.renames.length = 0;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const course = { id: 'course-1', code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2' };

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'course-folder-')));
  const root = join(base, 'Desktop');
  const downloads = join(base, 'Downloads');
  mkdirSync(root, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  const store = new SqliteRepository(':memory:');
  cleanups.push(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, root, downloads, store };
}

function write(path: string, content: string | Buffer, mtime: Date) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtime, mtime);
}

function listing(path: string): string[] {
  if (!existsSync(path)) return [];
  return (readdirSync(path, { recursive: true }) as string[]).sort();
}

const assignmentStage = (target: string, ...files: string[]) => ({ [`assignments.${target}`]: { policy: { value: 'unknown' }, files } });
const materialsStage = (...files: string[]) => ({ materials: { files, links: [{ label: 'Synthetic recording', url: 'https://example.edu/recording' }] } });

function archive(store: CourseFolderStore, root: string, downloads: string, jobStartedAt: string, stages: Record<string, unknown>,
  now: Date, assessmentIdFor: (target: string) => string | undefined = () => undefined) {
  return archiveCourse({ store, course, jobStartedAt, stages, assessmentIdFor, options: { root, downloadsDir: downloads, now: () => now } });
}

/** Wrap a real store so a test can see whether both records were written inside one transaction, after the move. */
function recordingStore(store: SqliteRepository, source: string, destination: string) {
  const calls: { file: SavedFile; insideTransaction: boolean; sourceExists: boolean; destinationContent: string }[] = [];
  let insideTransaction = false;
  const wrapped: CourseFolderStore = {
    saveSavedFile(file: SavedFile) {
      calls.push({
        file,
        insideTransaction,
        sourceExists: existsSync(source),
        destinationContent: existsSync(destination) ? readFileSync(destination, 'utf8') : '',
      });
      store.saveSavedFile(file);
    },
    listSavedFiles: courseId => store.listSavedFiles(courseId),
    listSavedFilesForAssessment: assessmentId => store.listSavedFilesForAssessment(assessmentId),
    loadAssessment: id => store.loadAssessment(id),
    transaction<T>(operation: () => T): T {
      insideTransaction = true;
      try {
        return store.transaction(operation);
      } finally {
        insideTransaction = false;
      }
    },
  };
  return { store: wrapped, calls };
}

function current(store: SqliteRepository, courseId: string): SavedFile {
  const records = store.listSavedFiles(courseId);
  const open = records.filter(record => record.supersededAt === undefined);
  expect(open).toHaveLength(1);
  return open[0]!;
}

/** Minimal synthetic MHTML: one multipart/related text/html part in the requested transfer encoding. */
function mhtml(html: string, encoding: 'quoted-printable' | 'base64'): string {
  const boundary = '----MultipartBoundary--synthetic----';
  const body = encoding === 'quoted-printable'
    ? [...Buffer.from(html, 'utf8')].map(byte => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
    : Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: <Saved by Blink>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related;',
    '  type="text/html";',
    `  boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: ' + encoding,
    'Content-Location: https://canvas.lms.unimelb.edu.au/courses/1/assignments/900001',
    '',
    body,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function page(script: string, visibleTimestamp: string): string {
  return [
    '<!doctype html><html><head>',
    `<script>window.savedAt = "${script}";</script>`,
    '</head><body>',
    '<h1>Synthetic assignment</h1>',
    `<p>Last saved ${visibleTimestamp}</p>`,
    '<p>Requirements: write a synthetic report.</p>',
    `<p data-loaded="${script}">Static instructions.</p>`,
    '</body></html>',
  ].join('');
}

/** Synthetic Edge/Blink MHTML with volatile cid references, CSRF values and non-HTML part headers. */
function blinkMhtml(html: string, ids: { css: string; frame: string; save: string }): string {
  const boundary = '----MultipartBoundary--blink----';
  const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64');
  return [
    'From: <Saved by Blink>',
    'Snapshot-Content-Location: https://canvas.lms.unimelb.edu.au/courses/1/pages/synthetic',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related;',
    '  type="text/html";',
    `  boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://canvas.lms.unimelb.edu.au/courses/1/pages/synthetic',
    '',
    encoded(html),
    `--${boundary}`,
    'Content-Type: text/css; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${ids.css}>`,
    `Content-Location: https://canvas.lms.unimelb.edu.au/assets/${ids.save}.css`,
    '',
    encoded('body { color: #000; }'),
    `--${boundary}`,
    'Content-Type: application/octet-stream',
    'Content-Transfer-Encoding: base64',
    `Content-ID: <${ids.frame}>`,
    `Content-Location: https://canvas.lms.unimelb.edu.au/frames/${ids.save}`,
    '',
    encoded('synthetic frame bytes'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function blinkPage(csrf: string, authenticity: string, visibleRequirement: string, ids: { css: string; frame: string }): string {
  return [
    '<!doctype html><html><head>',
    `<meta name="csrf-token" content="${csrf}">`,
    `<link rel="stylesheet" href="cid:${ids.css}">`,
    '</head><body>',
    '<h1>Synthetic assignment</h1>',
    `<p>${visibleRequirement}</p>`,
    `<iframe src="cid:${ids.frame}"></iframe>`,
    `<form><input type="hidden" name="authenticity_token" value="${authenticity}"></form>`,
    '</body></html>',
  ].join('');
}

describe('course folder (layered-sync 7.1)', () => {
  it('names folders by term and course, uses COURSEWORK_FILES, falls back to the code and replaces unsafe characters', () => {
    const { base } = setup();
    const root = join(base, 'Desktop');
    expect(termFolderName('2026:S2')).toBe('26S2');
    expect(termFolderName('2026:S1')).toBe('26S1');
    expect(termFolderName('2026:SUMMER')).toBe('26Summer');
    expect(termFolderName('2026:WINTER')).toBe('26Winter');

    expect(courseFolderPath(course, { root })).toBe(join(root, 'UniMelb 26S2', 'Synthetic Systems'));
    expect(courseFolderPath({ ...course, term: '2026:S1' }, { root })).toBe(join(root, 'UniMelb 26S1', 'Synthetic Systems'));
    expect(courseFolderPath({ ...course, name: undefined }, { root })).toBe(join(root, 'UniMelb 26S2', 'SYNA10001'));
    expect(courseFolderPath({ ...course, name: '   ' }, { root })).toBe(join(root, 'UniMelb 26S2', 'SYNA10001'));

    const envRoot = join(base, 'Course files');
    expect(courseFolderPath(course, { env: { COURSEWORK_FILES: envRoot }, homeDir: join(base, 'home') }))
      .toBe(join(envRoot, 'UniMelb 26S2', 'Synthetic Systems'));

    expect(sanitizePathSegment('A/B')).toBe('A_B');
    expect(sanitizePathSegment('a:b*c?d"e<f>g|h\\i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizePathSegment('a\u0001b')).toBe('a_b');
    expect(sanitizePathSegment('.hidden')).toBe('_hidden');
    expect(sanitizePathSegment('name. ')).toBe('name__');
    const unsafe = sanitizePathSegment('  ..Unsafe/Name: *?"<>|  ...  ');
    expect(unsafe).not.toMatch(/[\\/:*?"<>|]/);
    expect(unsafe).not.toMatch(/^\./);
    expect(unsafe).not.toMatch(/[ .]$/);
  });

  it('Download not found: an absent file or one modified before the job started is reported and nothing is moved', () => {
    const { root, downloads, store } = setup();
    const startedAt = '2026-10-25T00:00:00.000Z';
    write(join(downloads, 'old.pdf'), 'old bytes', new Date('2026-10-24T23:59:59.000Z'));
    write(join(downloads, 'spec (1).pdf'), 'fuzzy match must not be used', new Date('2026-10-25T01:00:00.000Z'));
    const result = archive(store, root, downloads, startedAt, materialsStage('spec.pdf', 'old.pdf'), new Date('2026-10-25T02:00:00.000Z'));
    expect(result.moved).toEqual([]);
    expect(result.missing.sort()).toEqual(['old.pdf', 'spec.pdf']);
    expect(existsSync(join(root, 'UniMelb 26S2', 'Synthetic Systems', 'materials', 'spec.pdf'))).toBe(false);
    expect(existsSync(join(root, 'UniMelb 26S2', 'Synthetic Systems', 'materials', 'old.pdf'))).toBe(false);
    expect(store.listSavedFiles(course.id)).toEqual([]);
  });

  it('Requirements changed: the old .mhtml keeps a date suffix and supersededAt, the new one is current and unopened, and markOpened clears the notice', () => {
    const { root, downloads, store } = setup();
    store.saveAssessment({ id: 'assessment-1', courseId: course.id, name: 'Synthetic Assignment', isFinal: false, status: 'not_started' });
    const firstAt = new Date('2026-10-20T00:30:00.000Z');
    const secondAt = new Date('2026-10-27T00:30:00.000Z');
    const firstHtml = page('first-load', '26 Oct 2026 at 10:15');
    const secondHtml = page('second-load', '27 Oct 2026 at 11:45');
    write(join(downloads, 'instructions.mhtml'), mhtml(firstHtml, 'quoted-printable'), new Date('2026-10-20T01:00:00.000Z'));
    const first = archive(store, root, downloads, '2026-10-20T00:00:00.000Z', assignmentStage('900001', 'instructions.mhtml'), firstAt,
      target => target === '900001' ? 'assessment-1' : undefined);
    expect(first.missing).toEqual([]);
    expect(first.updated).toEqual([]);
    const firstRecord = current(store, course.id);
    expect(firstRecord.assessmentId).toBe('assessment-1');
    expect(firstRecord.openedAt).toBeUndefined();
    expect(firstRecord.path).toBe(join('assessments', 'Synthetic Assignment', 'instructions.mhtml'));
    expect(hasUpdateNotice(store.listSavedFilesForAssessment('assessment-1'), firstRecord)).toBe(false);

    write(join(downloads, 'instructions.mhtml'), mhtml(secondHtml, 'base64'), new Date('2026-10-27T01:00:00.000Z'));
    const second = archive(store, root, downloads, '2026-10-27T00:00:00.000Z', assignmentStage('900001', 'instructions.mhtml'), secondAt,
      target => target === '900001' ? 'assessment-1' : undefined);
    expect(second.missing).toEqual([]);
    expect(second.updated).toHaveLength(1);
    const records = store.listSavedFilesForAssessment('assessment-1');
    expect(records).toHaveLength(2);
    const latest = current(store, course.id);
    const old = records.find(record => record.id !== latest.id)!;
    expect(old.supersededAt).toBe(secondAt.toISOString());
    expect(old.path).toBe(join('assessments', 'Synthetic Assignment', 'instructions (2026-10-20).mhtml'));
    expect(latest.fingerprint).not.toBe(firstRecord.fingerprint);
    expect(latest.openedAt).toBeUndefined();
    expect(hasUpdateNotice(records, latest)).toBe(true);
    expect(existsSync(join(root, 'UniMelb 26S2', 'Synthetic Systems', old.path))).toBe(true);
    expect(fingerprintFile(join(root, 'UniMelb 26S2', 'Synthetic Systems', old.path))).toBe(old.fingerprint);
    expect(fingerprintFile(join(root, 'UniMelb 26S2', 'Synthetic Systems', latest.path))).toBe(latest.fingerprint);

    const openedAt = new Date('2026-10-27T02:00:00.000Z');
    expect(markOpened(store, latest.id, openedAt).openedAt).toBe(openedAt.toISOString());
    expect(store.loadSavedFile(latest.id)?.openedAt).toBe(openedAt.toISOString());
    expect(hasUpdateNotice(store.listSavedFilesForAssessment('assessment-1'), store.loadSavedFile(latest.id)!)).toBe(false);
  });

  it('Same page saved twice with different script blocks and timestamps has the same fingerprint for quoted-printable and base64 and gives no notice', () => {
    const { root, downloads, store } = setup();
    store.saveAssessment({ id: 'assessment-1', courseId: course.id, name: 'Synthetic Assignment', isFinal: false, status: 'not_started' });
    const first = mhtml(page('2026-10-20T10:00:00+11:00', '26 Oct 2026 at 10:15'), 'quoted-printable');
    const second = mhtml(page('2026-10-27T11:30:00+11:00', '27 Oct 2026 at 11:45'), 'base64');
    write(join(downloads, 'instructions.mhtml'), first, new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', assignmentStage('900001', 'instructions.mhtml'), new Date('2026-10-20T02:00:00.000Z'),
      target => target === '900001' ? 'assessment-1' : undefined);
    const firstRecord = current(store, course.id);
    const firstFingerprint = fingerprintFile(join(root, 'UniMelb 26S2', 'Synthetic Systems', firstRecord.path));

    write(join(downloads, 'instructions.mhtml'), second, new Date('2026-10-27T01:00:00.000Z'));
    const result = archive(store, root, downloads, '2026-10-27T00:00:00.000Z', assignmentStage('900001', 'instructions.mhtml'),
      new Date('2026-10-27T02:00:00.000Z'), target => target === '900001' ? 'assessment-1' : undefined);
    expect(result.updated).toEqual([]);
    expect(firstFingerprint).toBe(firstRecord.fingerprint);
    expect(firstFingerprint).toBe(fingerprintFile(join(root, 'UniMelb 26S2', 'Synthetic Systems', current(store, course.id).path)));
    const records = store.listSavedFilesForAssessment('assessment-1');
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(firstRecord.id);
    expect(records[0]!.supersededAt).toBeUndefined();
    expect(records[0]!.openedAt).toBeUndefined();
  });

  it('materials go to materials/ and nothing in the course folder is ever deleted', () => {
    const { root, downloads, store } = setup();
    write(join(downloads, 'slides.pdf'), 'first material bytes', new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('slides.pdf'), new Date('2026-10-20T02:00:00.000Z'));
    const courseRoot = join(root, 'UniMelb 26S2', 'Synthetic Systems');
    const firstRecord = current(store, course.id);
    expect(firstRecord.assessmentId).toBeUndefined();
    expect(firstRecord.path).toBe(join('materials', 'slides.pdf'));
    expect(readFileSync(join(courseRoot, 'materials', 'slides.pdf'), 'utf8')).toBe('first material bytes');
    const before = listing(courseRoot);

    write(join(downloads, 'slides.pdf'), 'second material bytes', new Date('2026-10-27T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-27T00:00:00.000Z', materialsStage('slides.pdf'), new Date('2026-10-27T02:00:00.000Z'));
    const after = listing(courseRoot);
    expect(before.every(path => after.includes(path))).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(readFileSync(join(courseRoot, 'materials', 'slides (2026-10-20).pdf'), 'utf8')).toBe('first material bytes');
    expect(readFileSync(join(courseRoot, 'materials', 'slides.pdf'), 'utf8')).toBe('second material bytes');
    expect(store.listSavedFiles(course.id)).toHaveLength(2);
  });

  it('keeps an owner-edited current file with a date suffix before storing the matching download', () => {
    const { root, downloads, store } = setup();
    const courseRoot = join(root, 'UniMelb 26S2', 'Synthetic Systems');
    const destination = join(courseRoot, 'materials', 'notes.pdf');
    const source = join(downloads, 'notes.pdf');
    write(source, 'recorded bytes', new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('notes.pdf'), new Date('2026-10-20T02:00:00.000Z'));
    const record = current(store, course.id);

    writeFileSync(destination, 'owner annotation');
    write(source, 'recorded bytes', new Date('2026-10-27T01:00:00.000Z'));
    const result = archive(store, root, downloads, '2026-10-27T00:00:00.000Z', materialsStage('notes.pdf'),
      new Date('2026-10-27T02:00:00.000Z'));

    expect(readFileSync(destination, 'utf8')).toBe('recorded bytes');
    expect(readFileSync(join(courseRoot, 'materials', 'notes (2026-10-20).pdf'), 'utf8')).toBe('owner annotation');
    expect(existsSync(source)).toBe(false);
    expect(result.updated).toEqual([]);
    expect(store.listSavedFiles(course.id)).toHaveLength(1);
    expect(current(store, course.id).id).toBe(record.id);
    expect(current(store, course.id).fingerprint).toBe(record.fingerprint);
  });

  it('leaves the course folder and the Downloads copy alone when the download is already stored', () => {
    const { root, downloads, store } = setup();
    const destination = join(root, 'UniMelb 26S2', 'Synthetic Systems', 'materials', 'notes.pdf');
    const source = join(downloads, 'notes.pdf');
    write(source, 'same bytes', new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('notes.pdf'), new Date('2026-10-20T02:00:00.000Z'));
    const record = current(store, course.id);
    const savedMtime = statSync(destination).mtimeMs;

    write(source, 'same bytes', new Date('2026-10-27T01:00:00.000Z'));
    const result = archive(store, root, downloads, '2026-10-27T00:00:00.000Z', materialsStage('notes.pdf'),
      new Date('2026-10-27T02:00:00.000Z'));

    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe('same bytes');
    expect(statSync(destination).mtimeMs).toBe(savedMtime);
    expect(result.moved).toEqual([]);
    expect(store.listSavedFiles(course.id)).toHaveLength(1);
    expect(current(store, course.id).id).toBe(record.id);
  });

  it('moves the new file into place before writing both records inside one transaction', () => {
    const { root, downloads, store } = setup();
    const destination = join(root, 'UniMelb 26S2', 'Synthetic Systems', 'materials', 'notes.pdf');
    const source = join(downloads, 'notes.pdf');
    write(source, 'first bytes', new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('notes.pdf'), new Date('2026-10-20T02:00:00.000Z'));

    write(source, 'second bytes', new Date('2026-10-27T01:00:00.000Z'));
    const recorder = recordingStore(store, source, destination);
    const result = archive(recorder.store, root, downloads, '2026-10-27T00:00:00.000Z', materialsStage('notes.pdf'),
      new Date('2026-10-27T02:00:00.000Z'));

    expect(result.moved).toEqual([destination]);
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls.every(call => call.insideTransaction)).toBe(true);
    expect(recorder.calls.every(call => !call.sourceExists)).toBe(true);
    expect(recorder.calls.every(call => call.destinationContent === 'second bytes')).toBe(true);
    expect(recorder.calls[0]!.file.supersededAt).toBe('2026-10-27T02:00:00.000Z');
    expect(recorder.calls[1]!.file.supersededAt).toBeUndefined();
  });

  it('a failed move restores the old file name and keeps the old record current', () => {
    const { root, downloads, store } = setup();
    const courseRoot = join(root, 'UniMelb 26S2', 'Synthetic Systems');
    const destination = join(courseRoot, 'materials', 'notes.pdf');
    const source = join(downloads, 'notes.pdf');
    write(source, 'first bytes', new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('notes.pdf'), new Date('2026-10-20T02:00:00.000Z'));
    const record = current(store, course.id);

    write(source, 'second bytes', new Date('2026-10-27T01:00:00.000Z'));
    fsControl.beforeRename = from => {
      if (from === source) throw Object.assign(new Error('synthetic move failure'), { code: 'EIO' });
    };
    const result = archive(store, root, downloads, '2026-10-27T00:00:00.000Z', materialsStage('notes.pdf'),
      new Date('2026-10-27T02:00:00.000Z'));

    expect(result.moved).toEqual([]);
    expect(result.missing).toEqual(['notes.pdf']);
    expect(readFileSync(destination, 'utf8')).toBe('first bytes');
    expect(existsSync(join(courseRoot, 'materials', 'notes (2026-10-20).pdf'))).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(store.listSavedFiles(course.id)).toHaveLength(1);
    expect(current(store, course.id).id).toBe(record.id);
    expect(current(store, course.id).supersededAt).toBeUndefined();
  });

  it('copies through a temporary file in the destination folder when a cross-volume move fails', () => {
    const { root, downloads, store } = setup();
    const courseRoot = join(root, 'UniMelb 26S2', 'Synthetic Systems');
    const destination = join(courseRoot, 'materials', 'notes.pdf');
    const source = join(downloads, 'notes.pdf');
    write(source, 'cross volume bytes', new Date('2026-10-20T01:00:00.000Z'));

    let sourceExistedAtTempRename = false;
    fsControl.beforeRename = (from, to) => {
      if (from === source) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      if (to === destination) sourceExistedAtTempRename = existsSync(source);
    };
    const result = archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('notes.pdf'),
      new Date('2026-10-20T02:00:00.000Z'));

    expect(result.moved).toEqual([destination]);
    expect(readFileSync(destination, 'utf8')).toBe('cross volume bytes');
    expect(existsSync(source)).toBe(false);
    expect(sourceExistedAtTempRename).toBe(true);
    const temporary = fsControl.renames.find(call => call.to === destination && call.from !== source);
    expect(temporary).toBeDefined();
    expect(temporary!.from.startsWith(join(courseRoot, 'materials'))).toBe(true);
    expect(temporary!.from.endsWith('.tmp')).toBe(true);
    expect(listing(courseRoot).some(path => path.endsWith('.tmp'))).toBe(false);
  });

  it('normalizes Blink cid references, CSRF values and non-HTML part headers but keeps real page text', () => {
    const { downloads } = setup();
    const firstHtml = blinkPage(
      'csrf-token-one', 'authenticity-one', 'Stable requirement text.',
      { css: 'css-11111111-1111-1111-1111-111111111111@mhtml.blink', frame: 'frame-11111111-1111-1111-1111-111111111111@mhtml.blink' },
    );
    const secondHtml = blinkPage(
      'csrf-token-two', 'authenticity-two', 'Stable requirement text.',
      { css: 'css-22222222-2222-2222-2222-222222222222@mhtml.blink', frame: 'frame-22222222-2222-2222-2222-222222222222@mhtml.blink' },
    );
    const changedHtml = blinkPage(
      'csrf-token-two', 'authenticity-two', 'Changed requirement text.',
      { css: 'css-22222222-2222-2222-2222-222222222222@mhtml.blink', frame: 'frame-22222222-2222-2222-2222-222222222222@mhtml.blink' },
    );
    const first = join(downloads, 'blink-1.mhtml');
    const second = join(downloads, 'blink-2.mhtml');
    const changed = join(downloads, 'blink-3.mhtml');
    write(first, blinkMhtml(firstHtml, { css: 'css-11111111-1111-1111-1111-111111111111@mhtml.blink',
      frame: 'frame-11111111-1111-1111-1111-111111111111@mhtml.blink', save: 'save-one' }), new Date('2026-10-20T01:00:00.000Z'));
    write(second, blinkMhtml(secondHtml, { css: 'css-22222222-2222-2222-2222-222222222222@mhtml.blink',
      frame: 'frame-22222222-2222-2222-2222-222222222222@mhtml.blink', save: 'save-two' }), new Date('2026-10-27T01:00:00.000Z'));
    write(changed, blinkMhtml(changedHtml, { css: 'css-22222222-2222-2222-2222-222222222222@mhtml.blink',
      frame: 'frame-22222222-2222-2222-2222-222222222222@mhtml.blink', save: 'save-two' }), new Date('2026-10-27T01:00:00.000Z'));

    expect(fingerprintFile(first)).toBe(fingerprintFile(second));
    expect(fingerprintFile(changed)).not.toBe(fingerprintFile(first));
  });

  it('reports no update notice for first-saved materials in the same run and a notice only for the replaced file', () => {
    const { root, downloads, store } = setup();
    write(join(downloads, 'slides.pdf'), 'slides one', new Date('2026-10-20T01:00:00.000Z'));
    write(join(downloads, 'recording.mp4'), 'recording one', new Date('2026-10-20T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-20T00:00:00.000Z', materialsStage('slides.pdf', 'recording.mp4'),
      new Date('2026-10-20T02:00:00.000Z'));
    for (const file of store.listSavedFiles(course.id)) expect(hasUpdateNotice(store.listSavedFiles(course.id), file)).toBe(false);

    write(join(downloads, 'slides.pdf'), 'slides two', new Date('2026-10-27T01:00:00.000Z'));
    archive(store, root, downloads, '2026-10-27T00:00:00.000Z', materialsStage('slides.pdf'), new Date('2026-10-27T02:00:00.000Z'));
    const records = store.listSavedFiles(course.id);
    const open = records.filter(record => record.supersededAt === undefined);
    const slides = open.find(record => record.path === join('materials', 'slides.pdf'))!;
    const recording = open.find(record => record.path === join('materials', 'recording.mp4'))!;
    expect(hasUpdateNotice(records, slides)).toBe(true);
    expect(hasUpdateNotice(records, recording)).toBe(false);

    markOpened(store, slides.id, new Date('2026-10-27T03:00:00.000Z'));
    expect(hasUpdateNotice(store.listSavedFiles(course.id), store.loadSavedFile(slides.id)!)).toBe(false);
  });

  it('reports Downloads entries that are symlinks or directories as missing and never moves them', () => {
    const { root, downloads, store } = setup();
    write(join(downloads, 'real.pdf'), 'real bytes', new Date('2026-10-25T01:00:00.000Z'));
    symlinkSync(join(downloads, 'real.pdf'), join(downloads, 'link.pdf'));
    mkdirSync(join(downloads, 'folder.pdf'));
    const result = archive(store, root, downloads, '2026-10-25T00:00:00.000Z', materialsStage('link.pdf', 'folder.pdf'),
      new Date('2026-10-25T02:00:00.000Z'));

    expect(result.moved).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.missing.sort()).toEqual(['folder.pdf', 'link.pdf']);
    expect(listing(join(root, 'UniMelb 26S2', 'Synthetic Systems'))).toEqual([]);
    expect(existsSync(join(downloads, 'link.pdf'))).toBe(true);
    expect(existsSync(join(downloads, 'folder.pdf'))).toBe(true);
    expect(existsSync(join(downloads, 'real.pdf'))).toBe(true);
  });

  it('an unsupported term reports the course files and moves nothing without throwing', () => {
    const { root, downloads, store } = setup();
    const source = join(downloads, 'slides.pdf');
    write(source, 'material bytes', new Date('2026-10-25T01:00:00.000Z'));
    const result = archiveCourse({
      store,
      course: { ...course, term: '2026:Q1' },
      jobStartedAt: '2026-10-25T00:00:00.000Z',
      stages: materialsStage('slides.pdf'),
      assessmentIdFor: () => undefined,
      options: { root, downloadsDir: downloads, now: () => new Date('2026-10-25T02:00:00.000Z') },
    });

    expect(result.moved).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.missing).toEqual(['slides.pdf']);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(root, 'UniMelb 26Q1'))).toBe(false);
  });

  it('gives a second assessment with the same sanitized folder name its own folder', () => {
    const { root, downloads, store } = setup();
    store.saveAssessment({ id: 'assessment-1', courseId: course.id, name: 'Same / Assignment', isFinal: false, status: 'not_started' });
    store.saveAssessment({ id: 'assessment-2', courseId: course.id, name: 'Same / Assignment', isFinal: false, status: 'not_started' });
    write(join(downloads, 'one.pdf'), 'first assessment bytes', new Date('2026-10-25T01:00:00.000Z'));
    write(join(downloads, 'two.pdf'), 'second assessment bytes', new Date('2026-10-25T01:00:00.000Z'));
    const stages = {
      'assignments.900001': { files: ['one.pdf'] },
      'assignments.900002': { files: ['two.pdf'] },
    };
    const result = archive(store, root, downloads, '2026-10-25T00:00:00.000Z', stages, new Date('2026-10-25T02:00:00.000Z'),
      target => target === '900001' ? 'assessment-1' : target === '900002' ? 'assessment-2' : undefined);

    const courseRoot = join(root, 'UniMelb 26S2', 'Synthetic Systems');
    expect(readFileSync(join(courseRoot, 'assessments', 'Same _ Assignment', 'one.pdf'), 'utf8')).toBe('first assessment bytes');
    expect(readFileSync(join(courseRoot, 'assessments', 'Same _ Assignment (2)', 'two.pdf'), 'utf8')).toBe('second assessment bytes');
    expect(existsSync(join(courseRoot, 'assessments', 'Same _ Assignment', 'two.pdf'))).toBe(false);
    expect(result.moved).toHaveLength(2);
    expect(store.listSavedFilesForAssessment('assessment-1')[0]!.path).toBe(join('assessments', 'Same _ Assignment', 'one.pdf'));
    expect(store.listSavedFilesForAssessment('assessment-2')[0]!.path).toBe(join('assessments', 'Same _ Assignment (2)', 'two.pdf'));
  });

  it('an assignment whose assessment is not stored yet goes to assessments/<target>/ and is reported as unresolved', () => {
    const { root, downloads, store } = setup();
    write(join(downloads, 'spec.pdf'), 'synthetic pdf bytes', new Date('2026-10-25T01:00:00.000Z'));
    const destination = join(root, 'UniMelb 26S2', 'Synthetic Systems', 'assessments', '900009', 'spec.pdf');
    const result = archive(store, root, downloads, '2026-10-25T00:00:00.000Z', assignmentStage('900009', 'spec.pdf'),
      new Date('2026-10-25T02:00:00.000Z'), () => undefined);
    expect(result.moved).toEqual([destination]);
    expect(result.missing).toEqual([]);
    expect(result.unresolved).toEqual([destination]);
    expect(existsSync(destination)).toBe(true);
  });
});
