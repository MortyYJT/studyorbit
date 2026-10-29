import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyseInputHash, ANALYSE_VERSION, canonicalJson, captureEarlierDocument, capturedDocument, chooseCoursePath, collectInputHash,
  courseFolder, mergeInputHash, planMerge, sha256Hex, validateInputHash, verifySource,
} from '../scripts/lib/sync-stages.mjs';
import { resolveSourceSetup } from '../scripts/sources/registry.mjs';
import type { StageRow, SyncStore } from '../scripts/lib/sync-store.mjs';
import { courseDir, createProject, openStore, START, syntheticCourse, writeEarlierDocument, type Project } from './sync-fakes.ts';

// Stage helpers of the staged sync (design §6, decisions #345, #353, #354): input hashes, the captured earlier
// document, checkpoint verification and the merge decision. Synthetic data in a temporary project only.
let project: Project, store: SyncStore;
beforeEach(async () => { project = await createProject([syntheticCourse(1)]); store = await openStore(project.projectDir, () => START); });
afterEach(async () => { store.close(); await project.cleanup(); });

const course = { id: '900001', subjectCode: 'SYNT10001', term: '2026 Semester 2', name: 'Synthetic Course' };
const sources = (sha: string) => ({ canvas: { file: '/x/canvas.json', sha256: sha, exitCode: 0 }, ed: { file: '/x/ed.json', sha256: 'e', exitCode: 1 }, handbook: { file: '/x/h.json', sha256: 'h', exitCode: 0 } });

describe('input hashes', () => {
  it('are canonical: key order does not matter, values and versions do', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}');
    expect(collectInputHash({ courseId: '1', code: 'SYNT10001', term: 't' })).toBe(collectInputHash({ term: 't', code: 'SYNT10001', courseId: '1' }));
    expect(collectInputHash({ courseId: '1', code: 'SYNT10001', term: 't' })).not.toBe(collectInputHash({ courseId: '1', code: 'SYNT10001', term: 'u' }));
    expect(ANALYSE_VERSION).toBeGreaterThan(0);
  });

  it('analyse covers prompt, provider, model and base URL but never the key', () => {
    const config = { provider: 'deepseek' as const, model: 'm', baseUrl: null, apiKey: 'sk-synthetic-1' };
    const base = analyseInputHash({ prompt: 'p', config });
    expect(analyseInputHash({ prompt: 'p', config: { ...config, apiKey: 'sk-synthetic-2' } })).toBe(base);
    for (const changed of [{ prompt: 'q', config }, { prompt: 'p', config: { ...config, model: 'n' } }, { prompt: 'p', config: { ...config, provider: 'anthropic' as const } },
      { prompt: 'p', config: { ...config, baseUrl: 'https://llm.example.org/v1' } }]) expect(analyseInputHash(changed)).not.toBe(base);
  });

  it('validate covers the analysis, the collected files and the captured earlier document; merge covers the folder', () => {
    const base = validateInputHash({ analyseArtifact: 'a', sources: sources('c'), previous: null });
    expect(validateInputHash({ analyseArtifact: 'a', sources: sources('c'), previous: 'p' })).not.toBe(base);
    expect(validateInputHash({ analyseArtifact: 'a', sources: sources('d'), previous: null })).not.toBe(base);
    expect(validateInputHash({ analyseArtifact: 'b', sources: sources('c'), previous: null })).not.toBe(base);
    expect(mergeInputHash({ validateArtifact: 'v', courseDir: '/a' })).not.toBe(mergeInputHash({ validateArtifact: 'v', courseDir: '/b' }));
  });
});

describe('earlier document and checkpoints', () => {
  it('captures the newest valid earlier Desktop document as an artifact, or null', async () => {
    expect(await captureEarlierDocument(store, project.desktopDir, course)).toBeNull();
    await writeEarlierDocument(project.desktopDir, syntheticCourse(1));
    const hash = await captureEarlierDocument(store, project.desktopDir, course);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedDocument(store, hash)).toMatchObject({ version: 1, course: { id: '900001' } });
    expect(capturedDocument(store, null)).toBeNull();
    expect(courseFolder(project.desktopDir, course)).toBe(courseDir(project.desktopDir, syntheticCourse(1)));
  });

  it('verifies a collected file by its sha256', async () => {
    const file = join(project.root, 'canvas.json');
    await writeFile(file, '{"a":1}');
    expect(await verifySource({ file, sha256: sha256Hex('{"a":1}') })).toBe(true);
    await writeFile(file, '{"a":2}');
    expect(await verifySource({ file, sha256: sha256Hex('{"a":1}') })).toBe(false);
    expect(await verifySource({ file: join(project.root, 'missing.json'), sha256: 'x' })).toBe(false);
    expect(await verifySource(null)).toBe(false);
  });

  it('builds the collector commands as the sequential runner did, now from the sources, each with the configuration', () => {
    const { sources: [canvas, ed, handbook], context } = resolveSourceSetup();
    const env = { STUDYORBIT_SOURCE_CONFIG: expect.any(String) };
    expect(canvas.collect(course, context, '/r/canvas.json')).toEqual({ script: 'sources/canvas/collect.mjs', args: ['900001', '/r/canvas.json'], env });
    expect(ed.collect(course, context, '/r/ed.json')).toEqual({ script: 'sources/ed/collect.mjs', args: ['SYNT10001', '2026 Semester 2', '/r/ed.json'], env });
    expect(handbook.collect(course, context, '/r/h.json')).toEqual({ script: 'institutions/unimelb/handbook-collect.mjs', args: ['SYNT10001', '2026', '/r/h.json'], env });
    expect(handbook.collect({ ...course, term: 'Summer' }, context, '/r/h.json')).toBeNull();
  });
});

describe('merge decision', () => {
  const row = (jobId: string, inputHash: string, plannedPath: string | null, contentHash: string, status: StageRow['status'] = 'interrupted') =>
    ({ jobId, courseId: '900001', stage: 'merge', inputHash, status, checkpoint: plannedPath ? { plannedPath, contentHash } : null } as StageRow);

  it('completes from a row whose file exists with the recorded hash, whatever its status', async () => {
    const dir = courseDir(project.desktopDir, syntheticCourse(1));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '分数结构.json'), 'written');
    const written = row('job-1', 'm', join(dir, '分数结构.json'), sha256Hex('written'));
    expect(await planMerge([written], 'other')).toEqual({ kind: 'complete', row: written });
    const replaced = row('job-1', 'm', join(dir, '分数结构.json'), sha256Hex('something else'), 'failed');
    expect(await planMerge([replaced], 'm')).toEqual({ kind: 'conflict', row: replaced });
  });

  it('reuses the planned path of a row with the same input hash whose file is missing, else chooses a new path', async () => {
    const dir = courseDir(project.desktopDir, syntheticCourse(1));
    const missing = row('job-2', 'm', join(dir, '分数结构-job-2.json'), 'h', 'cancelled');
    expect(await planMerge([row('job-3', 'n', null, 'h'), missing], 'm')).toEqual({ kind: 'write', path: join(dir, '分数结构-job-2.json') });
    expect(await planMerge([missing], 'other')).toEqual({ kind: 'new' });
    expect(await planMerge([], 'm')).toEqual({ kind: 'new' });
    expect(await chooseCoursePath(dir, 'job-4')).toBe(join(dir, '分数结构.json'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '分数结构.json'), 'earlier');
    expect(await chooseCoursePath(dir, 'job-4')).toBe(join(dir, '分数结构-job-4.json'));
  });
});
