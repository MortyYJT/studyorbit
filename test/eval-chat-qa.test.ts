import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatQaSummary, parseArgs, runQaEvaluation, summariseQa, type QaMode, type QaRecord } from '../scripts/eval-chat-qa.mjs';

// The Q&A runner with scripted provider streams (--fake): no network, synthetic fixtures only.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'qa');
const temps: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'qa-eval-')); temps.push(dir); return dir; }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('parseArgs', () => {
  it('defaults to both modes and N = 5', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'both', n: 5, concurrency: 4 });
  });
  it('reads mode, N, question filter and overrides', () => {
    expect(parseArgs(['--mode', 'tools', '--n', '3', '--only', 'a,b', '--provider', 'deepseek', '--model', 'deepseek-flash']))
      .toMatchObject({ mode: 'tools', n: 3, only: ['a', 'b'], provider: 'deepseek', model: 'deepseek-flash' });
  });
  it('rejects bad values', () => {
    expect(() => parseArgs(['--n', '21'])).toThrow('--n');
    expect(() => parseArgs(['--n', '0'])).toThrow('--n');
    expect(() => parseArgs(['--mode', 'all'])).toThrow('--mode');
    expect(() => parseArgs(['--concurrency', '9'])).toThrow('--concurrency');
    expect(() => parseArgs(['--fake', 'x', '--model', 'm'])).toThrow('--fake');
    expect(() => parseArgs(['--what'])).toThrow('未知参数');
  });
});

/** Scripted DeepSeek steps per mode; a list of step lists varies by run. */
async function fakeDir() {
  const dir = await temp();
  await writeFile(join(dir, 'grade-average-zh.json'), JSON.stringify({
    context: [{ text: '平均 74.8%。', usage: { input: 1000, output: 50 } }],
    tools: [[{ calls: [{ name: 'calculate_grades', args: { courseId: 'qa-syn-1' } }] }, { text: '平均 74.8%。' }], [{ text: '大概 70%。' }]],
  }));
  await writeFile(join(dir, 'refusal-submit-zh.json'), JSON.stringify({
    context: [{ status: 500 }],
    tools: [{ text: '我不能替你提交，可以帮你规划。' }],
  }));
  return dir;
}

describe('runQaEvaluation with --fake', () => {
  it('writes N answers per question per mode with grades and a matching summary, without network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network used'); }));
    const out = await temp();
    const logs: string[] = [];
    const { summary } = await runQaEvaluation(
      { ...parseArgs(['--n', '2', '--only', 'grade-average-zh,refusal-submit-zh']), fake: await fakeDir(), out, fixtures: FIXTURES },
      { projectDir: process.cwd(), log: line => logs.push(line) },
    );
    expect(logs[0]).toContain('2 道题 × N 2 × 2 种模式 = 8 次对话');
    for (const mode of ['context', 'tools']) {
      for (const id of ['grade-average-zh', 'refusal-submit-zh']) {
        expect((await readdir(join(out, mode, id))).sort()).toEqual(['run-1.json', 'run-2.json']);
      }
    }
    const record = JSON.parse(await readFile(join(out, 'tools', 'grade-average-zh', 'run-1.json'), 'utf8'));
    expect(record).toMatchObject({ id: 'grade-average-zh', mode: 'tools', run: 1, category: 'grade', ok: true, text: '平均 74.8%。', grade: { pass: true } });
    expect(record.steps).toHaveLength(1);
    expect(JSON.parse(record.steps[0].result)).toMatchObject({ average: 74.8 });
    expect(record.usage).toEqual({ input: 200, cached: null, output: 20, reasoning: null });
    expect(typeof record.durationMs).toBe('number');
    const failed = JSON.parse(await readFile(join(out, 'context', 'refusal-submit-zh', 'run-2.json'), 'utf8'));
    expect(failed).toMatchObject({ ok: false, grade: { pass: false, failedCall: true } });
    expect(failed.error).toContain('HTTP 500');

    // context: grade passes twice, refusal fails twice (HTTP 500); tools: grade passes on run 1 only, refusal twice.
    expect(summary.modes.context).toMatchObject({ answers: 4, passed: 2, accuracy: 0.5, failedCalls: 2, fallbacks: 0 });
    expect(summary.modes.tools).toMatchObject({ answers: 4, passed: 3, accuracy: 0.75, failedCalls: 0 });
    expect(summary.modes.tools!.byCategory.grade).toEqual({ answers: 2, passed: 1, accuracy: 0.5 });
    expect(summary.modes.tools!.perQuestion['refusal-submit-zh']).toEqual({ answers: 2, passed: 2, rate: 1 });
    expect(summary.modes.tools!.toolUse).toMatchObject({ answersWithStep: 1, toolCalls: 1, calculationAnswers: 2, calculationAnswersWithTool: 1, byTool: { calculate_grades: 1 } });
    expect(summary.modes.context!.tokens).toMatchObject({ input: 2000, output: 100, answersWithUsage: 2 });

    for (const name of ['summary.json', 'summary.md', 'context/grade-average-zh/run-1.json']) expect((await stat(join(out, name))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'))).toMatchObject({ n: 2, provider: 'fake', questions: 2 });
    expect(await readFile(join(out, 'summary.md'), 'utf8')).toContain('| 总体 |');
  });

  it('runs one mode only when asked', async () => {
    const out = await temp();
    const { summary } = await runQaEvaluation({ ...parseArgs(['--mode', 'context', '--n', '1', '--only', 'grade-average-zh']), fake: await fakeDir(), out, fixtures: FIXTURES }, { projectDir: process.cwd(), log: () => {} });
    expect(Object.keys(summary.modes)).toEqual(['context']);
    expect(await readdir(out)).not.toContain('tools');
  });

  it('refuses unknown question IDs', async () => {
    await expect(runQaEvaluation({ ...parseArgs(['--only', 'nope']), fake: await fakeDir(), out: await temp(), fixtures: FIXTURES }, { projectDir: process.cwd(), log: () => {} }))
      .rejects.toThrow('nope');
  });

  it('refuses an output folder inside the Desktop before writing anything', async () => {
    const out = join(homedir(), 'Desktop', `qa-eval-refused-${process.pid}`);
    await expect(runQaEvaluation({ ...parseArgs([]), fake: await fakeDir(), out, fixtures: FIXTURES }, { projectDir: process.cwd(), log: () => {} }))
      .rejects.toThrow('OUT_DIR_NOT_ALLOWED');
    await expect(stat(out)).rejects.toThrow();
  });
});

describe('--rescore', () => {
  it('regrades saved answers with the current gold data without calling a model, into a new folder', async () => {
    const source = await temp();
    await runQaEvaluation({ ...parseArgs(['--n', '2', '--only', 'grade-average-zh,refusal-submit-zh']), fake: await fakeDir(), out: source, fixtures: FIXTURES }, { projectDir: process.cwd(), log: () => {} });
    // Edit one saved answer so the regrade differs from the original grade.
    const path = join(source, 'tools', 'grade-average-zh', 'run-2.json');
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), text: '平均 74.8%。' }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network used'); }));
    const out = await temp();
    const { summary } = await runQaEvaluation({ ...parseArgs(['--rescore', source]), out, fixtures: FIXTURES }, { projectDir: process.cwd(), log: () => {} });
    expect(summary).toMatchObject({ mode: 'rescore', source, provider: 'fake', model: 'fake-model', n: 2, questions: 2 });
    expect(summary.modes.tools).toMatchObject({ answers: 4, passed: 4, failedCalls: 0 });
    expect(summary.modes.context).toMatchObject({ answers: 4, passed: 2, failedCalls: 2 });
    expect((await readdir(out)).sort()).toEqual(['summary.json', 'summary.md']);
    expect(JSON.parse(await readFile(join(source, 'summary.json'), 'utf8')).modes.tools.passed).toBe(3);
  });

  it('refuses other run options and writing into the source folder', async () => {
    expect(() => parseArgs(['--rescore', 'x', '--model', 'm'])).toThrow('--rescore');
    expect(() => parseArgs(['--rescore', 'x', '--only', 'a'])).toThrow('--rescore');
    const source = await temp();
    await expect(runQaEvaluation({ ...parseArgs(['--rescore', source]), out: join(source, 'again'), fixtures: FIXTURES }, { projectDir: process.cwd(), log: () => {} }))
      .rejects.toThrow('OUT_DIR_NOT_ALLOWED');
  });
});

describe('summariseQa and formatQaSummary', () => {
  const question = (id: string, category: string) => ({ id, category, language: 'en', scope: [], question: id, gold: { answer: '', numbers: [], facts: [], forbidden: [], refusal: false, expectTools: [] } });
  const record = (id: string, mode: QaMode, pass: boolean, extra: Partial<QaRecord> = {}): QaRecord => ({
    id, mode, run: 1, ok: true, text: '', steps: [], usage: null, fallback: false, durationMs: 100, grade: { pass, failedCall: false, checks: [] }, ...extra,
  });

  it('counts tool use for grade and final-needed answers only by calculate_grades or final_needed', () => {
    const questions = [question('g', 'grade'), question('f', 'final'), question('l', 'lookup')];
    const summary = summariseQa([
      record('g', 'tools', true, { steps: [{ name: 'get_assessments' }] }),
      record('f', 'tools', true, { steps: [{ name: 'list_courses' }, { name: 'final_needed' }] }),
      record('l', 'tools', false, { steps: [{ name: 'get_assessments' }], fallback: true, usage: { input: 10, cached: 4, output: 3, reasoning: null } }),
    ], questions);
    expect(summary.tools!.toolUse).toEqual({ answersWithStep: 3, toolCalls: 4, calculationAnswers: 2, calculationAnswersWithTool: 1, byTool: { get_assessments: 2, list_courses: 1, final_needed: 1 } });
    expect(summary.tools).toMatchObject({ answers: 3, passed: 2, fallbacks: 1, tokens: { input: 10, cached: 4, output: 3, reasoning: 0, answersWithUsage: 1 } });
    expect(summary.tools!.durationMs).toEqual({ total: 300, mean: 100, max: 100 });
    expect(summary.context).toBeUndefined();
  });

  it('renders accuracy side by side per category', () => {
    const questions = [question('g', 'grade')];
    const modes = summariseQa([record('g', 'context', false), record('g', 'tools', true)], questions);
    const text = formatQaSummary({ startedAt: 'T', provider: 'fake', model: 'fake-model', n: 1, questions: 1, modes });
    expect(text).toContain('| grade | 0.0%（0/1） | 100.0%（1/1） |');
    expect(text).toContain('| 总体 | 0.0%（0/1） | 100.0%（1/1） |');
  });
});
