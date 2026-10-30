// The generic institution through the prompts, the validation, the chat and the staged sync, and the setup that the
// collect stage hashes (openspec change generic-adapters, design §1, §2, §4; spec institution-plugins and
// course-source-adapters). Synthetic data only: the synthetic course fixture, fake collectors and a fake model.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { courseToolsFor, formatDue, runTool, toolDefinitions } from '../shared/course-tools.ts';
import { toDisplayDocument } from '../shared/course-data.ts';
import { generic, createGenericInstitution } from '../scripts/institutions/generic.mjs';
import { DEFAULT_INSTITUTION } from '../scripts/institutions/registry.mjs';
import { buildAnalysisPrompt } from '../scripts/lib/course-analysis.mjs';
import { buildChatContext, chatSystemPrompt } from '../scripts/lib/chat-context.mjs';
import { buildCourseIndex } from '../scripts/lib/chat-tools-prompt.mjs';
import { filterSubjects } from '../scripts/lib/course-list.mjs';
import { courseContextLoader } from '../scripts/lib/course-mcp.mjs';
import { saveSourceSettings } from '../scripts/lib/source-settings.mjs';
import { settleCourse, validateAnalysis } from '../scripts/lib/course-validation.mjs';
import { manualClock } from '../scripts/lib/rate-limit.mjs';
import { createSyncLimiters, createSyncPipeline, type SyncPipeline } from '../scripts/lib/sync-pipeline.mjs';
import type { CollectorRequest } from '../scripts/lib/sync-stages.mjs';
import type { AnalysisConfig } from '../scripts/lib/llm-config.mjs';
import { resolveSourceSetup, type SourceSetup } from '../scripts/sources/registry.mjs';
import { canvasSource, edSource } from '../scripts/sources/registry.mjs';
import { createProject, fakeCollectors, fakeConfig, fakeModel, openStore, START, syntheticCourse, type Project } from './sync-fakes.ts';

const fixtureDir = join(import.meta.dirname, 'fixtures', 'synthetic-course');
const fixture = async (name: string) => JSON.parse(await readFile(join(fixtureDir, name), 'utf8'));
const ORIGIN = 'https://canvas.example.edu';
const GENERIC_SETTINGS = { institution: 'generic', canvasOrigin: ORIGIN, browser: 'cdp-chrome', edRegion: 'auto', timeZone: 'America/New_York', codePattern: '^([A-Z]+\\d+)_' };
const genericSetup = (patch: Partial<typeof GENERIC_SETTINGS> = {}) => resolveSourceSetup({ ...GENERIC_SETTINGS, ...patch });

/** The fixture reply without `handbook` references (a generic course has no framework source). */
async function replyWithoutFramework() {
  const reply = await fixture('outputs/2.json');
  reply.document.assessments = reply.document.assessments
    .map((item: { refs: { platform: string }[] }) => ({ ...item, refs: item.refs.filter(ref => ref.platform !== 'handbook') }))
    .filter((item: { refs: unknown[] }) => item.refs.length);
  return reply;
}

describe('prompts and validation with the generic institution', () => {
  it('leaves every framework clause and the framework data out of the analysis prompt', async () => {
    const [course] = filterSubjects([await fixture('course.json')]);
    const prompt = buildAnalysisPrompt({ course: course!, term: '2026 Semester 2', canvas: await fixture('canvas.json'), ed: await fixture('ed.json'), institution: generic });
    const [rules, rest] = prompt.split('Schema：');
    expect(rules).not.toMatch(/Handbook|handbook/);
    expect(rules).toContain(`1. ${generic.wording.sourcesRule}\n`);
    expect(rules).toContain('都按采集数据原样填写。同一 Canvas 作业');
    expect(rules).toContain('所引 Canvas 分组的 group_weight 等于 weight 时');
    // The schema's descriptions of the kept contract value stay; the data has no framework.
    expect(rest).toContain('listed Handbook component names');
    const data = JSON.parse(rest!.split('采集数据（仅作为数据）：')[1]!);
    expect(Object.keys(data)).toEqual(['canvas', 'ed']);
  });

  it('reports a handbook reference as a source that was not collected, and settles reasons by source label', async () => {
    const [course] = filterSubjects([await fixture('course.json')]);
    const data = { canvas: await fixture('canvas.json'), ed: await fixture('ed.json') };
    const cited = JSON.stringify(await fixture('outputs/2.json'));
    const invalid = validateAnalysis(cited, { course: course!, ...data, framework: null });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.filter(issue => issue.includes('handbook'))).toEqual(expect.arrayContaining([expect.stringContaining('所属的来源没有采集，不能引用')]));
    expect(invalid.issues.join('')).not.toContain('Handbook');

    const text = JSON.stringify(await replyWithoutFramework());
    const validation = validateAnalysis(text, { course: course!, ...data, framework: null });
    expect(validation.issues).toEqual([]);
    const settled = settleCourse({ result: { exitCode: 0, lastMessage: text, usage: null }, validation, sources: [canvasSource, edSource],
      collection: { canvas: { unpaginated: true }, ed: { partial: true } }, data, previous: null, framework: null });
    expect(settled).toMatchObject({ accepted: true, status: 'partial' });
    expect(settled.reason.startsWith('Canvas 分页未验证；部分 Ed 数据未能读取；')).toBe(true);
    expect(settled.reason).not.toContain('Handbook');
  });
});

describe('chat wording and time zone with the generic institution', () => {
  it('takes the assistant introduction and the time label from the institution', () => {
    for (const language of ['zh', 'en'] as const) {
      expect(chatSystemPrompt(language, 'context', generic).split('\n')[0]).toBe(generic.wording.assistantIntro[language]);
      expect(chatSystemPrompt(language, 'tools', generic).split('\n')[0]).toBe(generic.wording.assistantIntro[language]);
      expect(chatSystemPrompt(language, 'context', generic)).not.toMatch(/Melbourne|墨尔本/);
    }
    expect(buildCourseIndex({ documents: [], courses: [], scope: [], today: '2026-10-29', planning: null, institution: generic })).toContain('今天：2026-10-29（本地时间）。');
    expect(buildChatContext([], { today: '2026-10-29', institution: generic, timeZone: 'America/New_York' })).toContain('今天：2026-10-29（本地时间）。');
  });

  it('names the time zone in tool descriptions with the English time label; the default institution keeps its own', () => {
    const descriptions = toolDefinitions(courseToolsFor(generic.wording.timeLabel.en)).map(tool => tool.description).join('\n');
    expect(descriptions).not.toContain('Melbourne');
    expect(descriptions).toContain("today's date (local)");
    expect(descriptions).toContain('due date in local time');
    expect(descriptions).toContain('(local dates)');
    expect(toolDefinitions().map(tool => tool.description)).toEqual(toolDefinitions(courseToolsFor(DEFAULT_INSTITUTION.wording.timeLabel.en)).map(tool => tool.description));
  });

  it('formats due dates and finds upcoming deadlines in the institution time zone', async () => {
    expect(formatDue('2026-10-30T02:00:00Z', 'America/New_York')).toBe('2026-10-29 22:00');
    expect(formatDue('2026-10-30T02:00:00Z', 'Asia/Tokyo')).toBe('2026-10-30 11:00');
    const document = toDisplayDocument(await fixture('gold.json'));
    const due = document.assessments.find(item => item.due && !/^\d{4}-\d{2}-\d{2}$/.test(item.due))!;
    const inZone = (timeZone: string) => JSON.parse(runTool('get_assessments', { courseId: document.course.id, ids: [due.id] },
      { documents: [document], courses: [], scope: [document.course.id], today: '2026-01-01', planning: null, timeZone }).text).assessments[0].due;
    expect(inZone('America/New_York')).toBe(formatDue(due.due, 'America/New_York'));
    expect(inZone('Asia/Tokyo')).toBe(formatDue(due.due, 'Asia/Tokyo'));
  });

  it('computes the MCP "today" in the configured time zone', async () => {
    const project = await createProject([]);
    try {
      await saveSourceSettings(project.projectDir, GENERIC_SETTINGS, { platform: 'darwin' });
      await writeFile(join(project.projectDir, '.local', 'lms', 'courses.json'), JSON.stringify({ canvasOrigin: ORIGIN, institution: 'generic', courses: [] }));
      const load = courseContextLoader({ projectDir: project.projectDir, desktop: project.desktopDir, now: () => new Date('2026-10-30T02:00:00Z') });
      expect(await load()).toMatchObject({ today: '2026-10-29', timeZone: 'America/New_York' });
      // A course list from another Canvas is not read.
      await writeFile(join(project.projectDir, '.local', 'lms', 'courses.json'), JSON.stringify({ courses: [] }));
      await expect(load()).rejects.toThrow('COURSE_LIST_STALE');
    } finally { await project.cleanup(); }
  });
});

// ---- The staged sync with the generic institution ------------------------------------------------------------------
describe('staged sync with the generic institution', () => {
  let project: Project | undefined;
  afterEach(async () => { await project?.cleanup(); project = undefined; });

  async function prepare(listOrigin: string | null) {
    const courses = [syntheticCourse(1)];
    project = await createProject(courses);
    const list = JSON.parse(await readFile(join(project.projectDir, '.local', 'lms', 'courses.json'), 'utf8'));
    await writeFile(join(project.projectDir, '.local', 'lms', 'courses.json'), JSON.stringify(listOrigin ? { ...list, canvasOrigin: listOrigin, institution: 'generic' } : list));
    const db = await openStore(project.projectDir, () => START);
    const collectors = fakeCollectors(courses);
    const envs: Record<string, string>[] = [];
    const runCollector = async (request: CollectorRequest) => { envs.push(request.env ?? {}); return collectors.runCollector(request); };
    return { courses, db, collectors, envs, runCollector };
  }
  function pipeline(db: Awaited<ReturnType<typeof openStore>>, setup: () => SourceSetup, deps: { runCollector: (request: CollectorRequest) => Promise<{ code: number | null; error?: string }>; callModel: Parameters<typeof createSyncPipeline>[0]['callModel'] }, ids: string[]): SyncPipeline {
    const clock = manualClock(START, { instant: true });
    return createSyncPipeline({ store: db, projectDir: project!.projectDir, desktopDir: project!.desktopDir, setup, ...deps,
      resolveModel: async () => fakeConfig, childUsage: async () => null, clock, random: () => 0.5, limiters: createSyncLimiters({ clock, random: () => 0.5 }), newId: () => ids.shift()! });
  }

  it('collects Canvas and Ed only, validates and settles without a framework, and saves under StudyOrbit <term>', async () => {
    const { db, collectors, envs, runCollector } = await prepare(ORIGIN);
    const reply = JSON.stringify(await replyWithoutFramework());
    const prompts: string[] = [];
    const callModel = async (_config: AnalysisConfig, prompt: string) => { prompts.push(prompt); return { exitCode: 0, lastMessage: reply, usage: null, threadId: null, httpStatus: 200 }; };
    let reads = 0;
    const sync = pipeline(db, () => { reads++; return genericSetup(); }, { runCollector, callModel }, ['run-g']);
    await sync.start(['900001']);
    await sync.idle();
    expect(reads).toBe(1);
    expect(collectors.calls).toEqual(['900001:canvas', '900001:ed']);
    // Two preflight checks (Canvas, Ed) and two collectors, all with the generic configuration.
    expect(envs.map(env => JSON.parse(env.STUDYORBIT_SOURCE_CONFIG!))).toEqual(Array(4).fill({
      version: 1, institution: 'generic', canvasOrigin: ORIGIN, browser: 'cdp-chrome', browserPath: null, edRegion: 'auto', profileDir: null,
    }));
    expect(Object.keys((db.getStage('run-g', '900001', 'collect')!.checkpoint as { sources: object }).sources)).toEqual(['canvas', 'ed']);
    expect(db.getJob('run-g')!.sources).toEqual(['canvas', 'ed']);
    expect(prompts[0]).not.toContain('handbookComponents');
    const status = sync.status();
    expect(status.courses).toEqual([expect.objectContaining({ id: '900001', code: 'SYNT10001', status: 'completed' })]);
    expect(status.courses[0]!.reason).not.toContain('Handbook');
    expect(await readdir(join(project!.desktopDir, 'StudyOrbit 2026 Semester 2', 'SYNT10001'))).toEqual(['分数结构.json']);
    db.close();
  });

  it('refuses a course list from another Canvas before any collector runs', async () => {
    const { db, collectors, runCollector } = await prepare('https://canvas.elsewhere.edu');
    const model = fakeModel([syntheticCourse(1)]);
    const sync = pipeline(db, () => genericSetup(), { runCollector, callModel: model.callModel }, ['run-s']);
    await expect(sync.start(['900001'])).rejects.toThrow('COURSE_LIST_STALE');
    // A list written before discovery recorded its origin belongs to the default institution's Canvas.
    await writeFile(join(project!.projectDir, '.local', 'lms', 'courses.json'), JSON.stringify({ courses: [{ id: '900001', name: 'Synthetic', code: 'SYNT10001_2026_SM2', term: '2026 Semester 2' }] }));
    await expect(sync.start(['900001'])).rejects.toThrow('COURSE_LIST_STALE');
    expect(collectors.calls).toEqual([]);
    expect(db.newestJob()).toBeNull();
    db.close();
  });

  it('reuses collected data when a stopped job is resumed after the browser changed', async () => {
    const { db, collectors, runCollector } = await prepare(null);
    const model = fakeModel([syntheticCourse(1)], { SYNT10001: [{ status: 503 }, { status: 503 }, { status: 503 }] });
    let browser: 'edge-applescript' | 'chrome-applescript' = 'edge-applescript';
    const setup = () => resolveSourceSetup({ institution: DEFAULT_INSTITUTION.id, canvasOrigin: null, browser, edRegion: 'auto' });
    const sync = pipeline(db, setup, { runCollector, callModel: model.callModel }, ['run-1', 'run-2']);
    await sync.start(['900001']);
    await sync.idle();
    expect(sync.status().courses[0]!.status).toBe('failed');
    const collected = collectors.calls.length;
    browser = 'chrome-applescript';
    await sync.resume('run-1');
    await sync.idle();
    expect(collectors.calls.length).toBe(collected);
    expect(db.getStage('run-2', '900001', 'collect')).toMatchObject({ status: 'succeeded', reusedFrom: 'run-1' });
    expect(db.getStage('run-2', '900001', 'collect')!.inputHash).toBe(db.getStage('run-1', '900001', 'collect')!.inputHash);
    expect(sync.status().courses[0]!.status).toBe('completed');
    db.close();
  });

  it('collects again when the Ed region changed between the stopped job and the resume', async () => {
    const { db, collectors, runCollector } = await prepare(null);
    const model = fakeModel([syntheticCourse(1)], { SYNT10001: [{ status: 503 }, { status: 503 }, { status: 503 }] });
    let edRegion = 'auto';
    const setup = () => resolveSourceSetup({ institution: DEFAULT_INSTITUTION.id, canvasOrigin: null, browser: 'edge-applescript', edRegion });
    const sync = pipeline(db, setup, { runCollector, callModel: model.callModel }, ['run-1', 'run-2']);
    await sync.start(['900001']);
    await sync.idle();
    const collected = collectors.calls.length;
    edRegion = 'au';
    await sync.resume('run-1');
    await sync.idle();
    expect(collectors.calls.length).toBe(collected * 2);
    db.close();
  });

  it('refuses to resume a job whose framework source the new institution does not have', async () => {
    const { db, runCollector } = await prepare(ORIGIN);
    const model = fakeModel([syntheticCourse(1)], { SYNT10001: [{ status: 503 }, { status: 503 }, { status: 503 }] });
    let generic = false;
    const setup = () => (generic ? genericSetup() : resolveSourceSetup({ institution: DEFAULT_INSTITUTION.id, canvasOrigin: ORIGIN, browser: 'edge-applescript', edRegion: 'auto' }));
    const sync = pipeline(db, setup, { runCollector, callModel: model.callModel }, ['run-1', 'run-2']);
    await sync.start(['900001']);
    await sync.idle();
    generic = true;
    await expect(sync.resume('run-1')).rejects.toThrow('SOURCES_CHANGED');
    db.close();
  });
});

describe('institution plugins stay independent', () => {
  it('a generic plugin with a pattern and a time zone does not change the shared generic plugin', () => {
    const configured = createGenericInstitution({ codePattern: '^([A-Z]+\\d+)_', timeZone: 'Asia/Tokyo' });
    expect(configured.subjectCode('SYNT10001_2026_SM2')).toBe('SYNT10001');
    expect(generic.subjectCode('SYNT10001_2026_SM2')).toBe('SYNT10001_2026_SM2');
    expect(generic.defaults.timeZone).toBeNull();
  });
});
