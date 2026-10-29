import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toDisplayDocument } from '../shared/course-data.js';
import { buildAnalysisPrompt } from '../scripts/lib/course-analysis.mjs';
import { loadCourseReports, newestCourseDocument } from '../scripts/lib/course-reports.mjs';
import { analyseWithRepair, settleCourse, validateAnalysis } from '../scripts/lib/course-validation.mjs';

// End to end on synthetic data: model output v2 + collected fixtures + an earlier v1 course file in a temporary
// Desktop folder → the saved v2 file is read back by course-reports. Same steps as scripts/course-sync-runner.mjs.
const fixture = join(import.meta.dirname, 'fixtures', 'synthetic-course');
const readJson = async (name: string) => JSON.parse(await readFile(join(fixture, name), 'utf8'));

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'studyorbit-sync-v2-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('sync with contract v2', () => {
  it('saves a stored v2 document with legacy IDs from the earlier v1 file and reads it back', async () => {
    const listed = await readJson('course.json');
    const course = { ...listed, subjectCode: 'SYNT10001' };
    const [canvas, ed, handbook] = await Promise.all(['canvas.json', 'ed.json', 'handbook.json'].map(readJson));
    const project = join(root, 'project'), desktop = join(root, 'Desktop');
    const folder = join(desktop, '墨尔本大学 2026 S2', 'SYNT10001');
    await mkdir(join(project, '.local', 'lms'), { recursive: true });
    await writeFile(join(project, '.local', 'lms', 'courses.json'), JSON.stringify({ courses: [listed] }));
    await mkdir(folder, { recursive: true });
    // The earlier v1 file (the synthetic gold document stands in for a v1 sync result).
    await cp(join(fixture, 'gold.json'), join(folder, '分数结构.json'));
    const old = new Date(Date.UTC(2026, 8, 1));
    await utimes(join(folder, '分数结构.json'), old, old);

    const instructions = buildAnalysisPrompt({ course, term: course.term, canvas, ed, handbook });
    const output = await readFile(join(fixture, 'outputs', '2.json'), 'utf8');
    const { result, validation } = await analyseWithRepair({
      instructions, run: async () => ({ exitCode: 0, lastMessage: output, usage: null }),
      validate: raw => validateAnalysis(raw, { course, canvas, ed, handbook }), isCancelled: () => false,
    });
    const previous = await newestCourseDocument(folder, course.id);
    expect(previous?.version).toBe(1);
    const settled = settleCourse({ result, validation, collection: {}, data: { canvas, ed, handbook }, previous });
    expect(settled).toMatchObject({ accepted: true, status: 'completed', reason: '' });
    await writeFile(join(folder, '分数结构-run2.json'), `${JSON.stringify(settled.document, null, 2)}\n`, { flag: 'wx' });

    const { reports } = await loadCourseReports(project, { desktop });
    expect(reports).toHaveLength(1);
    const saved = reports[0].report;
    expect(saved?.version).toBe(2);
    if (saved?.version !== 2) return;
    expect(saved.legacyIds).toEqual({
      'canvas-group-501': 'canvas-group:501', 7101: 'canvas:7101', 7102: 'canvas:7102', 7001: 'canvas:7001',
      3003: 'ed:3003', 7201: 'canvas:7201', 'handbook-lab-hurdle': 'handbook:laboratory-attendance',
    });
    const byId = new Map(saved.assessments.map(item => [item.id, item]));
    expect(byId.get('canvas:7001')).toMatchObject({
      name: 'Assignment 1', parentId: null, weight: 30, score: 24, maxScore: 30, due: '2026-08-28T13:59:00Z', status: 'graded',
      refs: [{ platform: 'canvas', id: '7001' }, { platform: 'ed', id: '3001' }, { platform: 'handbook', id: 'Assignment 1' }],
      unsourced: [],
    });
    expect(byId.get('canvas:7101')).toMatchObject({ parentId: 'canvas-group:501', score: 8, maxScore: 10, status: 'graded' });
    expect(byId.get('handbook:laboratory-attendance')).toMatchObject({ due: null, score: null, maxScore: null, status: 'unknown',
      sources: [{ platform: 'handbook', url: handbook.url, evidence: null }] });
    expect(toDisplayDocument(saved).assessments).toHaveLength(7);
  });
});
