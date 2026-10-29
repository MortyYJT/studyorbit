import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeRunner, evaluateCourses, loadFixture, parseArgs, resolveEvalConfig, runEvaluation } from '../scripts/eval-course-analysis.mjs';

// The synthetic fixture uses an invented course (SYNT10001) and example.* URLs only.
const fixture = join(import.meta.dirname, 'fixtures', 'synthetic-course');
const cells = 7 * 9;
const edIssue = 'Ed 已得 24/30，请使用同一来源的得分和满分';
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('parseArgs', () => {
  it('reads options and rejects bad values', () => {
    expect(parseArgs(['--fixture', 'f', '--n', '3', '--out', 'o'])).toMatchObject({ fixture: 'f', n: 3, out: 'o', live: false });
    expect(parseArgs(['--run', 'r', '--gold', 'g', '--model', 'm', '--provider', 'deepseek'])).toMatchObject({ run: 'r', gold: 'g', model: 'm', provider: 'deepseek', n: 5 });
    expect(() => parseArgs(['--n', '0'])).toThrow();
    expect(() => parseArgs(['--unknown'])).toThrow();
    expect(() => parseArgs(['--run', 'r'])).toThrow();
  });
});

describe('evaluateCourses on the synthetic fixture', () => {
  it('intercepts the wrong output and scores the accepted ones', async () => {
    const course = await loadFixture(fixture);
    expect(course.course.subjectCode).toBe('SYNT10001');
    // Calls: run 1 → 1.json (rejected) then 2.json (repair), run 2 → 3.json, run 3 → 4.json.
    const evaluation = await evaluateCourses({ courses: [course], n: 3, run: createFakeRunner(join(fixture, 'outputs')) });
    const [result] = evaluation.courses;
    expect(result.runs.map(run => run.attempts.length)).toEqual([2, 1, 1]);
    expect(result.runs[0].attempts[0].issues).toEqual([`assessments.3: ${edIssue}`]);
    expect(result.runs.every(run => run.accepted)).toBe(true);

    const summary = result.summary;
    expect(summary.interception).toEqual({ runs: 3, repairTriggered: 1, rejected: 0, issues: { [edIssue]: 1 } });
    expect(summary.documentRuns).toBe(3);
    // Run 2 misses the lab hurdle (9 cells), has the wrong Quiz 2 status (1 cell) and one extra practice item.
    expect(summary.fieldAccuracy).toBeCloseTo((3 * cells - 10) / (3 * cells), 10);
    expect(summary.perField.status).toBeCloseTo(19 / 21, 10);
    expect(summary.perField.parentId).toBeCloseTo(20 / 21, 10);
    expect(summary.recall).toBeCloseTo(20 / 21, 10);
    expect(summary.precision).toBeCloseTo(20 / 21, 10);
    expect(summary.cellAgreement).toBeCloseTo((cells - 10) / cells, 10);
    expect(summary.identicalToFirst).toBeCloseTo(2 / 3, 10);
    expect(evaluation.overall.fieldAccuracy).toBe(summary.fieldAccuracy);
  });

  it('rejects a run whose repair attempt is also invalid', async () => {
    const course = await loadFixture(fixture);
    const wrong = await readFile(join(fixture, 'outputs', '1.json'), 'utf8');
    const evaluation = await evaluateCourses({ courses: [course], n: 1, run: async () => ({ exitCode: 0, lastMessage: wrong, usage: null }) });
    expect(evaluation.courses[0].runs[0]).toMatchObject({ accepted: false, document: null });
    expect(evaluation.courses[0].summary.interception).toEqual({ runs: 1, repairTriggered: 1, rejected: 1, issues: { [edIssue]: 2 } });
    expect(evaluation.courses[0].summary.fieldAccuracy).toBeNull();
  });
});

describe('runEvaluation', () => {
  it('writes every run and the summaries into the out directory', async () => {
    const out = await mkdtemp(join(tmpdir(), 'studyorbit-eval-'));
    temps.push(out);
    const logs: string[] = [];
    const { summary } = await runEvaluation(parseArgs(['--fixture', fixture, '--n', '2', '--out', out]), { projectDir: process.cwd(), env: {}, log: line => logs.push(line) });
    expect(summary.mode).toBe('fake');
    expect((await readdir(join(out, 'SYNT10001'))).sort()).toEqual(['run-1.json', 'run-2.json']);
    const run1 = JSON.parse(await readFile(join(out, 'SYNT10001', 'run-1.json'), 'utf8'));
    expect(run1.attempts).toHaveLength(2);
    expect(typeof run1.attempts[0].raw).toBe('string');
    expect(run1).toHaveProperty('durationMs');
    expect(run1).toHaveProperty('usage');
    const saved = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
    expect(saved.overall.interception.repairTriggered).toBe(1);
    expect(await readFile(join(out, 'summary.md'), 'utf8')).toContain('SYNT10001');
    expect(logs.join('\n')).toContain('SYNT10001');
  });

  it('refuses to write into the desktop', async () => {
    await expect(runEvaluation(parseArgs(['--fixture', fixture, '--out', join(homedir(), 'Desktop', 'eval')]), { projectDir: process.cwd(), env: {}, log: () => {} }))
      .rejects.toThrow('OUT_DIR_NOT_ALLOWED');
  });
});

describe('resolveEvalConfig', () => {
  it('never carries a generic key over to an overriding provider', async () => {
    const project = await mkdtemp(join(tmpdir(), 'studyorbit-eval-config-'));
    temps.push(project);
    const env = { COURSE_ANALYSIS_PROVIDER: 'openai-compatible', COURSE_ANALYSIS_URL: 'https://llm.example.com/v1', COURSE_ANALYSIS_API_KEY: 'generic-key', COURSE_ANALYSIS_MODEL: 'm1' };
    expect(await resolveEvalConfig(project, env)).toMatchObject({ provider: 'openai-compatible', apiKey: 'generic-key', model: 'm1' });
    expect(await resolveEvalConfig(project, env, { provider: 'deepseek' })).toMatchObject({ provider: 'deepseek', apiKey: null });
    expect(await resolveEvalConfig(project, { ...env, DEEPSEEK_API_KEY: 'vendor-key' }, { provider: 'deepseek', model: 'm2' }))
      .toMatchObject({ provider: 'deepseek', apiKey: 'vendor-key', model: 'm2' });
  });
});
