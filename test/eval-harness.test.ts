import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeRunner, evaluateCourses, isInside, loadFixture, loadRun, parseArgs, resolveEvalConfig, runEvaluation } from '../scripts/eval-course-analysis.mjs';

// The synthetic fixture uses an invented course (SYNT10001) and example.* URLs only.
const fixture = join(import.meta.dirname, 'fixtures', 'synthetic-course');
const cells = 7 * 9;
const refIssue = 'refs.0: 「Quiz 2」引用的 canvas 7999 不是采集到的 Canvas 作业 ID';
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
    expect(result.runs[0].attempts[0].issues).toEqual([`assessments.2.${refIssue}`]);
    expect(result.runs.every(run => run.accepted)).toBe(true);
    // The runs are scored as stored v2 documents (code-filled IDs and facts) against the v1 gold, matched by name.
    expect(result.runs[0].document?.version).toBe(2);
    expect(result.runs[0].document?.assessments.map(item => item.id)).toEqual(['canvas-group:501', 'canvas:7101', 'canvas:7102', 'canvas:7001', 'ed:3003', 'canvas:7201', 'handbook:laboratory-attendance']);

    const summary = result.summary;
    expect(summary.interception).toEqual({ runs: 3, repairTriggered: 1, rejected: 0, failed: 0, issues: { [refIssue]: 1 } });
    expect(summary.documentRuns).toBe(3);
    // Every run: the group status (unknown vs in_progress) and the bonus maximum and status come from code and differ from
    // the gold (3 cells). Run 2 also misses the lab hurdle (9 cells), has the wrong Quiz 2 kind (1 cell) and one extra practice item.
    expect(summary.fieldAccuracy).toBeCloseTo((3 * cells - 3 * 3 - 10) / (3 * cells), 10);
    expect(summary.perField.status).toBeCloseTo(14 / 21, 10);
    expect(summary.perField.kind).toBeCloseTo(19 / 21, 10);
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
    expect(evaluation.courses[0].summary.interception).toEqual({ runs: 1, repairTriggered: 1, rejected: 1, failed: 0, issues: { [refIssue]: 2 } });
    expect(evaluation.courses[0].summary.fieldAccuracy).toBeNull();
  });
});

describe('model failures', () => {
  it('counts a failing model call as failed, not rejected, and tallies no issues', async () => {
    const course = await loadFixture(fixture);
    const evaluation = await evaluateCourses({ courses: [course], n: 2, run: async () => ({ exitCode: 1, lastMessage: '', usage: null, error: 'boom' }) });
    expect(evaluation.courses[0].runs.map(run => [run.accepted, run.failed])).toEqual([[false, true], [false, true]]);
    expect(evaluation.courses[0].summary.interception).toEqual({ runs: 2, repairTriggered: 0, rejected: 0, failed: 2, issues: {} });
    expect(evaluation.overall.interception.failed).toBe(2);
  });

  it('counts a thrown error as failed', async () => {
    const course = await loadFixture(fixture);
    const evaluation = await evaluateCourses({ courses: [course], n: 1, run: async () => { throw new Error('network down'); } });
    expect(evaluation.courses[0].runs[0]).toMatchObject({ accepted: false, failed: true, reason: 'network down' });
    expect(evaluation.courses[0].summary.interception).toMatchObject({ rejected: 0, failed: 1, issues: {} });
  });

  it('counts a run cut short by cancellation as failed', async () => {
    const course = await loadFixture(fixture);
    const wrong = await readFile(join(fixture, 'outputs', '1.json'), 'utf8');
    let cancelled = false;
    const evaluation = await evaluateCourses({ courses: [course], n: 1, isCancelled: () => cancelled,
      run: async () => { cancelled = true; return { exitCode: 0, lastMessage: wrong, usage: null }; } });
    expect(evaluation.courses[0].summary.interception).toMatchObject({ rejected: 0, failed: 1 });
  });
});

describe('loadRun', () => {
  async function runLayout(goldText?: string) {
    const root = await mkdtemp(join(tmpdir(), 'studyorbit-eval-run-'));
    temps.push(root);
    const course = JSON.parse(await readFile(join(fixture, 'course.json'), 'utf8'));
    await writeFile(join(root, 'courses.json'), JSON.stringify({ courses: [course] }));
    await mkdir(join(root, 'run', course.id), { recursive: true });
    for (const name of ['canvas', 'ed', 'handbook']) await cp(join(fixture, `${name}.json`), join(root, 'run', course.id, `${name}.json`));
    await mkdir(join(root, 'gold'));
    if (goldText !== undefined) await writeFile(join(root, 'gold', 'SYNT10001.json'), goldText);
    return { runDir: join(root, 'run'), coursesPath: join(root, 'courses.json'), goldDir: join(root, 'gold') };
  }

  it('loads a course with gold and skips one without a gold file', async () => {
    expect((await loadRun(await runLayout(await readFile(join(fixture, 'gold.json'), 'utf8')))).courses).toHaveLength(1);
    expect((await loadRun(await runLayout())).skipped).toEqual([{ id: '900001', code: 'SYNT10001', reason: '没有标准答案文件' }]);
  });

  it('fails loudly on a gold file that is not valid JSON', async () => {
    await expect(loadRun(await runLayout('{ not json'))).rejects.toThrow(/SYNT10001\.json/);
  });
});

describe('isInside', () => {
  it('sees through symlinks and paths that do not exist yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyorbit-eval-guard-'));
    temps.push(root);
    await mkdir(join(root, 'Desk'));
    await symlink(join(root, 'Desk'), join(root, 'link'));
    expect(await isInside(join(root, 'link', 'new', 'deeper'), join(root, 'Desk'))).toBe(true);
    expect(await isInside(join(root, 'Desk'), join(root, 'Desk'))).toBe(true);
    expect(await isInside(join(root, 'Desktop2'), join(root, 'Desk'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('ignores case on macOS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studyorbit-eval-case-'));
    temps.push(root);
    await mkdir(join(root, 'Desk'));
    expect(await isInside(join(root, 'desk', 'eval'), join(root, 'Desk'))).toBe(true);
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
    expect(saved.overall.unsourced).toEqual({ weight: expect.any(Number), rule: expect.any(Number) });
    expect(saved.courses[0].summary.unsourced.perRun).toHaveLength(2);
    const markdown = await readFile(join(out, 'summary.md'), 'utf8');
    expect(markdown).toContain('SYNT10001');
    expect(markdown).toContain('无出处（权重/规则）');
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
