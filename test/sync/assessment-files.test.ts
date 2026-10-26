import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { decodeMhtmlHtml, fingerprintFile, courseFolderPath, htmlToText } from '../../src/sync/course-folder.js';
import { courseEvidenceSnapshot } from '../../src/revision/sources.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const course = { id: 'course-synthetic', moduleId: 'module-synthetic', code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2', assessmentsComplete: false };
const at = '2026-10-24T00:00:00Z';
const assignment = { id: 'assignment-synthetic', courseId: course.id, name: 'Synthetic Assignment', kind: 'assignment' as const, isFinal: false, status: 'not_started' as const };
const exam = { id: 'exam-synthetic', courseId: course.id, name: 'Synthetic Exam', kind: 'exam' as const, isFinal: true, status: 'not_started' as const };

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'assessment-files-')));
  const root = join(base, 'Desktop');
  const downloads = join(base, 'Downloads');
  mkdirSync(root, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  const store = new SqliteRepository(':memory:');
  store.saveModule({ id: course.moduleId, name: 'Synthetic', glyph: 'S', auto: false });
  store.saveCourse(course);
  store.saveAssessment(assignment);
  store.saveAssessment(exam);
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(base, 'journal')),
    owner: { assertOwner: async () => {} }, assessmentFilesOptions: { root, downloadsDir: downloads } });
  cleanups.push(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const call = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  return { base, root, downloads, store, host, call };
}

const folder = (f: ReturnType<typeof setup>) => courseFolderPath(course, { root: f.root });

function saveFile(f: ReturnType<typeof setup>, assessmentId: string, name: string, bytes: string | Buffer, savedAt = at) {
  const relative = join('assessments', 'Synthetic Assignment', name);
  const absolute = join(folder(f), relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  f.store.saveSavedFile({ id: `saved-${name}`, courseId: course.id, assessmentId,
    path: relative, fingerprint: fingerprintFile(absolute), savedAt });
  return { relative, absolute };
}

function download(f: ReturnType<typeof setup>, name: string, bytes: string | Buffer, mtime: Date) {
  const path = join(f.downloads, name);
  writeFileSync(path, bytes);
  utimesSync(path, mtime, mtime);
  return path;
}

function mhtml(html: string): string {
  const boundary = '----SyntheticBoundary----';
  return [
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function page(text: string): string {
  return `<!doctype html><html><head><script>window.synthetic = "ignored";</script><style>p { color: red; }</style></head><body><h1>Synthetic assignment</h1><p>${text}</p></body></html>`;
}

type Data = { files: { sourceItemId?: string; name: string; kind: string; extracted: boolean; text?: string }[]; nothing_saved?: boolean; instructions?: string };

it('Start an assignment: stores one material SourceItem for the saved page, lists the PDF, and a rubric citation verifies', async () => {
  const f = setup();
  const rubric = 'Rubric: cite the synthetic line and explain the synthetic method.';
  saveFile(f, assignment.id, 'instructions.mhtml', mhtml(page(rubric)));
  saveFile(f, assignment.id, 'brief.pdf', Buffer.from('%PDF-1.7 synthetic bytes'));
  const result = await f.call('assessment.files', { assessmentId: assignment.id });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  const data = result.data as Data;
  const html = data.files.find(file => file.name === 'instructions.mhtml')!;
  const pdf = data.files.find(file => file.name === 'brief.pdf')!;
  expect(html).toMatchObject({ kind: 'html', extracted: true, sourceItemId: expect.any(String) });
  expect(html.text).toContain(rubric);
  expect(html.text).not.toContain('window.synthetic');
  expect(html.text).not.toContain('color: red');
  expect(pdf).toEqual({ name: 'brief.pdf', kind: 'pdf', extracted: false });
  expect(JSON.stringify(data)).not.toContain(f.root);

  const materials = f.store.query('sourceItems', { courseId: course.id, kind: 'material', limit: 10 }).items;
  expect(materials).toHaveLength(1);
  expect(materials[0]).toMatchObject({ id: html.sourceItemId, kind: 'material', courseId: course.id });
  expect(f.store.currentAssessmentLinks(assignment.id)).toEqual([
    expect.objectContaining({ assessmentId: assignment.id, sourceItemId: html.sourceItemId }),
  ]);

  const revision = courseEvidenceSnapshot(f.store, new TrustedStoreEvidence(f.store), course.id).sourceRevision;
  expect(await f.call('annotation.record', { entity: 'assessment', entityId: assignment.id, field: 'weight', value: 50,
    sourceRevision: revision, citations: [{ sourceItemId: html.sourceItemId, quote: rubric, locator: 'text' }] }))
    .toMatchObject({ ok: true, data: { citations: [{ sourceItemId: html.sourceItemId, quote: rubric }] } });
});

it('a re-call does not duplicate the SourceItem and a superseded file is not returned', async () => {
  const f = setup();
  const old = saveFile(f, assignment.id, 'old-page.mhtml', mhtml(page('Old rubric line.')));
  const first = await f.call('assessment.files', { assessmentId: assignment.id });
  expect(first).toMatchObject({ ok: true });
  if (!first.ok) return;
  const oldId = (first.data as Data).files[0]!.sourceItemId!;
  expect(f.store.query('sourceItems', { courseId: course.id, limit: 10 }).items).toHaveLength(1);

  f.store.saveSavedFile({ ...f.store.loadSavedFile('saved-old-page.mhtml')!, supersededAt: '2026-10-25T00:00:00Z' });
  saveFile(f, assignment.id, 'new-page.mhtml', mhtml(page('New rubric line.')));

  const second = await f.call('assessment.files', { assessmentId: assignment.id });
  expect(second).toMatchObject({ ok: true });
  if (!second.ok) return;
  const data = second.data as Data;
  expect(data.files.map(file => file.name)).toEqual(['new-page.mhtml']);
  expect(data.files[0]!.sourceItemId).not.toBe(oldId);
  expect(data.files[0]!.text).toContain('New rubric line.');

  const before = f.store.query('sourceItems', { courseId: course.id, limit: 10 }).items;
  const third = await f.call('assessment.files', { assessmentId: assignment.id });
  expect(third).toMatchObject({ ok: true });
  if (!third.ok) return;
  expect((third.data as Data).files[0]!.sourceItemId).toBe(data.files[0]!.sourceItemId);
  expect(f.store.query('sourceItems', { courseId: course.id, limit: 10 }).items).toHaveLength(before.length);
  expect(old.absolute).toBeTruthy();
});

it('nothing saved returns instructions; saved names are moved exactly, while missing and too-old names are reported', async () => {
  const f = setup();
  const empty = await f.call('assessment.files', { assessmentId: assignment.id });
  expect(empty).toMatchObject({ ok: true, data: { files: [], nothing_saved: true } });
  if (!empty.ok) return;
  expect((empty.data as Data).instructions).toMatch(/Save as/i);
  expect((empty.data as Data).instructions).toMatch(/saved/i);

  const now = new Date();
  download(f, 'page.mhtml', mhtml(page('Moved rubric line.')), now);
  download(f, 'page (1).mhtml', mhtml(page('Fuzzy match must not be used.')), now);
  download(f, 'old.mhtml', mhtml(page('Too old to move.')), new Date(now.getTime() - 31 * 60_000));
  const moved = await f.call('assessment.files', { assessmentId: assignment.id, saved: ['page.mhtml', 'old.mhtml', 'absent.mhtml'] });
  expect(moved).toMatchObject({ ok: true });
  if (!moved.ok) return;
  const data = moved.data as Data;
  expect(data.nothing_saved).toBeUndefined();
  expect(data.files.map(file => file.name)).toEqual(['page.mhtml']);
  expect(data.files[0]!.text).toContain('Moved rubric line.');
  expect(data.instructions).toContain('old.mhtml');
  expect(data.instructions).toContain('absent.mhtml');
  const movedPath = join(folder(f), 'assessments', 'Synthetic Assignment', 'page.mhtml');
  expect(htmlToText(decodeMhtmlHtml(readFileSync(movedPath)))).toContain('Moved rubric line.');
  expect(existsSync(join(f.downloads, 'page (1).mhtml'))).toBe(true);
  expect(existsSync(join(f.downloads, 'old.mhtml'))).toBe(true);
  expect(f.store.listSavedFilesForAssessment(assignment.id).map(record => record.path.split(/[\\/]/).at(-1))).toEqual(['page.mhtml']);
});

it('assessment.files is refused for an exam and an unknown assessment, and is an agent tool', async () => {
  const f = setup();
  expect(await f.call('assessment.files', { assessmentId: exam.id })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(await f.call('assessment.files', { assessmentId: 'missing-assessment' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  expect(f.host.registry.get('assessment.files')).toMatchObject({ level: 0 });
  const names = f.host.registry.agentTools(f.host.context).registry.list().map(entry => entry.name);
  expect(names).toContain('assessment.files');
});

it('bounds a large response to the first text part and names the SourceItems to read', async () => {
  const f = setup();
  saveFile(f, assignment.id, 'first.html', page('A'.repeat(50_000)));
  saveFile(f, assignment.id, 'second.html', page('B'.repeat(50_000)));
  const result = await f.call('assessment.files', { assessmentId: assignment.id });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) return;
  const text = JSON.stringify(result);
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  const data = result.data as Data;
  expect(data.files[0]!.text!.length).toBeGreaterThan(0);
  expect(data.files[1]!.text?.length ?? 0).toBeLessThan(50_000);
  expect(data.instructions).toContain(data.files[1]!.sourceItemId!);
  const full = await f.call('sources.get', { sourceItemId: data.files[1]!.sourceItemId! });
  expect(full).toMatchObject({ ok: true });
  if (full.ok) expect((full.data as { text: string }).text.length).toBeGreaterThanOrEqual(50_000);
});
