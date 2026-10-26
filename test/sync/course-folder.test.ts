import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SavedFile } from '../../src/domain/schemas.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import {
  archiveCourse, courseFolderPath, fingerprintFile, markOpened, sanitizePathSegment, termFolderName,
} from '../../src/sync/course-folder.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
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

function archive(store: SqliteRepository, root: string, downloads: string, jobStartedAt: string, stages: Record<string, unknown>,
  now: Date, assessmentIdFor: (target: string) => string | undefined = () => undefined) {
  return archiveCourse({ store, course, jobStartedAt, stages, assessmentIdFor, options: { root, downloadsDir: downloads, now: () => now } });
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
    expect(existsSync(join(root, 'UniMelb 26S2', 'Synthetic Systems', old.path))).toBe(true);
    expect(fingerprintFile(join(root, 'UniMelb 26S2', 'Synthetic Systems', old.path))).toBe(old.fingerprint);
    expect(fingerprintFile(join(root, 'UniMelb 26S2', 'Synthetic Systems', latest.path))).toBe(latest.fingerprint);

    const openedAt = new Date('2026-10-27T02:00:00.000Z');
    expect(markOpened(store, latest.id, openedAt).openedAt).toBe(openedAt.toISOString());
    expect(store.loadSavedFile(latest.id)?.openedAt).toBe(openedAt.toISOString());
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

  it('an assignment whose assessment is not stored yet goes to assessments/<target>/ and is reported', () => {
    const { root, downloads, store } = setup();
    write(join(downloads, 'spec.pdf'), 'synthetic pdf bytes', new Date('2026-10-25T01:00:00.000Z'));
    const result = archive(store, root, downloads, '2026-10-25T00:00:00.000Z', assignmentStage('900009', 'spec.pdf'),
      new Date('2026-10-25T02:00:00.000Z'), () => undefined);
    expect(result.moved).toEqual([join(root, 'UniMelb 26S2', 'Synthetic Systems', 'assessments', '900009', 'spec.pdf')]);
    expect(result.missing).toEqual(['spec.pdf']);
    expect(existsSync(join(root, 'UniMelb 26S2', 'Synthetic Systems', 'assessments', '900009', 'spec.pdf'))).toBe(true);
  });
});
