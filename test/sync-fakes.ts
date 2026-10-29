// Fakes for the staged sync pipeline (design §10): synthetic courses made from test/fixtures/synthetic-course with other
// synthetic IDs, fake collectors that write those fixtures, a fake model that answers with the fixture output, a
// temporary project and Desktop, and a store in the temporary project. Never real collectors, a real model, the
// owner's `.local` or Desktop.
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { manualClock } from '../scripts/lib/rate-limit.mjs';
import { createSyncLimiters, createSyncPipeline, type PipelineDeps, type PipelineHooks } from '../scripts/lib/sync-pipeline.mjs';
import type { CollectorRequest, Source } from '../scripts/lib/sync-stages.mjs';
import { openSyncStore, type SyncStore } from '../scripts/lib/sync-store.mjs';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';
import type { AnalysisResult } from '../scripts/lib/llm-providers.mjs';

const fixtureDir = join(import.meta.dirname, 'fixtures', 'synthetic-course');
const fixtureText = (name: string) => readFile(join(fixtureDir, name), 'utf8');

export type SyntheticCourse = { id: string; code: string; term: string };
/** Course n (1-based): ID 90000n, subject code SYNTn000n, term 2026 Semester 2. */
export const syntheticCourse = (n: number): SyntheticCourse => ({ id: `90000${n}`, code: `SYNT${n}000${n}`, term: '2026 Semester 2' });
const rename = (text: string, course: SyntheticCourse) =>
  text.replaceAll('900001', course.id).replaceAll('SYNT10001', course.code).replaceAll('synt10001', course.code.toLowerCase());

export const fakeConfig: AnalysisConfig = { provider: 'deepseek', model: 'fake-model', baseUrl: null, apiKey: 'synthetic-key' };

export type Project = { root: string; projectDir: string; desktopDir: string; cleanup(): Promise<void> };
export async function createProject(courses: SyntheticCourse[]): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'studyorbit-pipeline-'));
  const projectDir = join(root, 'project'), desktopDir = join(root, 'Desktop');
  await mkdir(join(projectDir, '.local', 'lms'), { recursive: true });
  await mkdir(desktopDir, { recursive: true });
  await writeCourseList(projectDir, courses);
  return { root, projectDir, desktopDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export async function writeCourseList(projectDir: string, courses: SyntheticCourse[]) {
  await writeFile(join(projectDir, '.local', 'lms', 'courses.json'), JSON.stringify({
    fetchedAt: '2026-10-01T00:00:00.000Z', scope: 'synthetic',
    courses: courses.map(course => ({ id: course.id, name: 'Synthetic Course', code: `${course.code}_2026_SM2`, term: course.term })),
  }));
}
export const courseDir = (desktopDir: string, course: SyntheticCourse) => join(desktopDir, '墨尔本大学 2026 S2', course.code);

/** An earlier v1 document (the synthetic gold file) whose Assignment 1 weight differs, so the change log gets a line. */
export async function writeEarlierDocument(desktopDir: string, course: SyntheticCourse) {
  const gold = JSON.parse(rename(await fixtureText('gold.json'), course));
  gold.assessments = gold.assessments.map((item: { id: string; weight: number | null }) => item.id === '7001' ? { ...item, weight: 25 } : item);
  const folder = courseDir(desktopDir, course);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '分数结构.json'), JSON.stringify(gold));
  const old = new Date(Date.UTC(2026, 8, 1));
  await utimes(join(folder, '分数结构.json'), old, old);
}

type CollectorScript = { exit?: number[]; hang?: boolean; partial?: boolean };
/**
 * Fake collectors: write the course's fixture to the output path (the last argument) and exit 0, or follow a script
 * per `<courseId>:<source>`: a list of exit codes for successive calls (1 → no file, 75 → temporary failure), a
 * fixture marked `partial`, or hang until stopped. `calls` lists every invocation; `active` tracks overlap.
 */
export function fakeCollectors(courses: SyntheticCourse[], scripts: Record<string, CollectorScript> = {}) {
  const calls: string[] = [];
  const overlaps: string[] = [];
  let active: string | null = null;
  const counts = new Map<string, number>();
  const runCollector = async ({ source, args, registerStop, signal }: CollectorRequest) => {
    const course = courses.find(item => args.includes(item.id) || args.includes(item.code))!;
    const key = `${course.id}:${source}`;
    calls.push(key);
    if (active) overlaps.push(`${active}+${key}`);
    active = key;
    try {
      const script = scripts[key] ?? {};
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      if (script.hang) {
        await new Promise<void>(resolve => { const untrack = registerStop(() => { untrack(); resolve(); }); signal.addEventListener('abort', () => resolve(), { once: true }); });
        return { code: null, error: 'stopped' };
      }
      const code = script.exit?.[index] ?? script.exit?.at(-1) ?? 0;
      if (code !== 0) return { code, error: `synthetic exit ${code}` };
      if (signal.aborted) return { code: null, error: 'stopped' };
      const data = JSON.parse(rename(await fixtureText(`${source}.json`), course));
      if (script.partial) data.status = 'partial';
      await writeFile(args.at(-1)!, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      return { code: 0 };
    } finally { active = null; }
  };
  return { runCollector, calls, overlaps, count: (filter: (key: string) => boolean = () => true) => calls.filter(filter).length };
}

type ModelReply = { status?: number; retryAfterMs?: number; hang?: boolean; invalid?: boolean; exitCode?: number; error?: string };
const usageOf = (prompt: string, reply: string) => ({ input: Math.ceil(prompt.length / 4), cached: 0, output: Math.ceil(reply.length / 4), reasoning: 0 });
/**
 * Fake model: the fixture output for the course named in the prompt, with deterministic usage (prompt length ÷ 4 and
 * reply length ÷ 4, rounded up). A script per course code lists replies for successive calls: an invalid reply
 * (repaired by the next call), an HTTP status with optional Retry-After, a non-zero exit, or a hang until aborted.
 */
export function fakeModel(courses: SyntheticCourse[], scripts: Record<string, ModelReply[]> = {}) {
  const calls: string[] = [];
  let inFlight = 0, peak = 0;
  const counts = new Map<string, number>();
  const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  const callModel = async (_config: AnalysisConfig, prompt: string, { registerStop }: { registerStop(stop: () => void): () => void }): Promise<AnalysisResult> => {
    const course = courses.find(item => prompt.includes(`"code":"${item.code}"`))!;
    calls.push(course.id);
    const index = counts.get(course.id) ?? 0;
    counts.set(course.id, index + 1);
    const reply = scripts[course.code]?.[index] ?? {};
    inFlight++; peak = Math.max(peak, inFlight);
    try {
      if (reply.hang) {
        await new Promise<void>(resolve => { const untrack = registerStop(() => { untrack(); resolve(); }); });
        return { exitCode: 1, lastMessage: '', usage: null, error: '模型请求已中止或超时。' };
      }
      await new Promise(resolve => setImmediate(resolve));
      if (reply.status) return { exitCode: 1, lastMessage: '', usage: null, error: `DeepSeek 接口返回 HTTP ${reply.status}。`, httpStatus: reply.status, retryAfterMs: reply.retryAfterMs ?? null };
      if (reply.exitCode) return { exitCode: reply.exitCode, lastMessage: '', usage: null, error: reply.error };
      const text = reply.invalid ? '{"status":"completed","reason":"","document":{}}' : rename(await fixtureText(join('outputs', '2.json')), course);
      const counted = usageOf(prompt, text);
      for (const key of ['input', 'output'] as const) usage[key] += counted[key];
      return { exitCode: 0, lastMessage: text, usage: counted, threadId: null, httpStatus: 200 };
    } finally { inFlight--; }
  };
  return { callModel, calls, usage, peak: () => peak, count: (courseId?: string) => calls.filter(id => !courseId || id === courseId).length };
}

/** A store in the project, with the given clock. */
export async function openStore(projectDir: string, clock: () => number): Promise<SyncStore> {
  const opened = await openSyncStore({ projectDir, clock });
  if (!opened.ok) throw new Error(`store unavailable: ${opened.reason}`);
  return opened.store;
}

export const START = Date.UTC(2026, 9, 30, 0, 0, 0);
/** A pipeline over the project with fakes and a virtual clock whose sleeps complete at once. */
export function pipelineFor(project: Project, store: SyncStore, fakes: { runCollector: PipelineDeps['runCollector']; callModel: PipelineDeps['callModel'] },
  options: { clock?: ReturnType<typeof manualClock>; hooks?: PipelineHooks; config?: AnalysisConfig; ids?: string[] } = {}) {
  const clock = options.clock ?? manualClock(START, { instant: true });
  const ids = [...(options.ids ?? [])];
  let next = 0;
  return createSyncPipeline({
    store, projectDir: project.projectDir, desktopDir: project.desktopDir, runCollector: fakes.runCollector, callModel: fakes.callModel,
    resolveModel: async () => options.config ?? fakeConfig, childUsage: async () => null, clock, random: () => 0.5,
    limiters: createSyncLimiters({ clock, random: () => 0.5 }), hooks: options.hooks, newId: () => ids.shift() ?? `job-${++next}`,
  });
}

/** Every file under the Desktop folder, relative path → bytes, with job IDs in file names normalised. */
export async function desktopFiles(desktopDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(desktopDir, path).replace(/分数结构-[^/]+\.json$/, '分数结构-<run>.json')] = await readFile(path, 'utf8');
    }
  };
  await walk(desktopDir);
  return files;
}

export async function changeLogLines(projectDir: string): Promise<Record<string, unknown>[]> {
  let raw = '';
  try { raw = await readFile(join(projectDir, '.local', 'lms', 'changes.jsonl'), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function usageLines(projectDir: string): Promise<Record<string, any>[]> {
  let raw = '';
  try { raw = await readFile(join(projectDir, '.local', 'lms', 'course-sync-usage.jsonl'), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export type Fakes = { collectors: ReturnType<typeof fakeCollectors>; model: ReturnType<typeof fakeModel> };
export const sources: Source[] = ['canvas', 'ed', 'handbook'];
