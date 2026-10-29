import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCourseReports } from '../scripts/lib/course-reports.mjs';

// Synthetic course folders in a temporary directory; never the owner's Desktop.
const course = { id: '900001', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' };
const v1Item = { id: 'a1', name: 'Assignment 1', kind: 'assignment', nature: 'regular', parentId: null, weight: 20, score: null, maxScore: 20,
  due: null, status: 'not_started', scoring: 'none', rule: null, sources: [] };
const v1 = { version: 1, course, assessments: [v1Item], materials: [] };
const v2 = { version: 2, course, materials: [], legacyIds: { a1: 'canvas:5551' },
  assessments: [{ ...v1Item, id: 'canvas:5551', refs: [{ platform: 'canvas', id: '5551' }], weight: null, weightQuote: null, ruleQuote: null, unsourced: ['weight'] }] };

let root: string, folder: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studyorbit-reports-'));
  await mkdir(join(root, 'project', '.local', 'lms'), { recursive: true });
  await writeFile(join(root, 'project', '.local', 'lms', 'courses.json'), JSON.stringify({ courses: [{ id: course.id, name: course.name, code: 'SYNT10001_2026_SM2', term: course.term }] }));
  folder = join(root, 'Desktop', '墨尔本大学 2026 S2', 'SYNT10001');
  await mkdir(folder, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Writes course files; later entries get later modification times. */
async function files(entries: [string, unknown][]) {
  for (const [index, [name, data]] of entries.entries()) {
    const path = join(folder, name);
    await writeFile(path, JSON.stringify(data));
    const time = new Date(Date.UTC(2026, 9, 1, 0, index));
    await utimes(path, time, time);
  }
}
const load = async () => (await loadCourseReports(join(root, 'project'), { desktop: join(root, 'Desktop') })).reports;

describe('loadCourseReports', () => {
  it('reads a v1 file unchanged', async () => {
    await files([['分数结构.json', v1]]);
    expect(await load()).toEqual([{ id: course.id, report: v1 }]);
  });

  it('uses a newer v2 file over an older v1 file', async () => {
    await files([['分数结构.json', v1], ['分数结构-2.json', v2]]);
    expect(await load()).toEqual([{ id: course.id, report: v2 }]);
  });

  it('treats version 3 as invalid and falls back to the next newest valid file', async () => {
    await files([['分数结构.json', v1], ['分数结构-3.json', { ...v2, version: 3 }]]);
    expect(await load()).toEqual([{ id: course.id, report: v1 }]);
  });

  it('skips an invalid v2 file', async () => {
    const invalid = { ...v2, assessments: [{ ...v2.assessments[0], unsourced: ['score'] }] };
    await files([['分数结构.json', v1], ['分数结构-2.json', invalid]]);
    expect(await load()).toEqual([{ id: course.id, report: v1 }]);
  });
});
