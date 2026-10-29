// Golden outputs of the UniMelb setup (openspec change generic-adapters, design §4 "Golden tests", decision #448),
// recorded from the code before any of it moved behind the source, institution and browser interfaces. Every later
// PR of the change must reproduce them byte for byte with the `unimelb` plugin and no settings file. Synthetic data
// only: the synthetic course fixture, synthetic Canvas/Ed/Handbook responses and fake collectors; never a browser,
// the Ed CLI, the network or a model.
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolDefinitions } from '../shared/course-tools.ts';
import { buildAnalysisPrompt } from '../scripts/lib/course-analysis.mjs';
import { chatSystemPrompt } from '../scripts/lib/chat-context.mjs';
import { toolSystemPrompt } from '../scripts/lib/chat-tools-prompt.mjs';
import { filterSubjects, normalizeCourses } from '../scripts/lib/course-list.mjs';
import { repairPrompt, settleCourse, validateAnalysis } from '../scripts/lib/course-validation.mjs';
import { collectInputHash, courseFolder, termLabel, validateInputHash } from '../scripts/lib/sync-stages.mjs';
import type { CollectorRequest } from '../scripts/lib/sync-stages.mjs';
import { callTranscript, runCollectorScript, type CollectorScenario } from './collector-harness.ts';
import { createProject, fakeCollectors, fakeModel, openStore, pipelineFor, START, syntheticCourse, type Project } from './sync-fakes.ts';

const fixtureDir = join(import.meta.dirname, 'fixtures', 'synthetic-course');
const fixture = async (name: string) => JSON.parse(await readFile(join(fixtureDir, name), 'utf8'));
const golden = (name: string) => join(import.meta.dirname, 'golden', name);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function collected() {
  const [course] = filterSubjects([await fixture('course.json')]);
  return { course, canvas: await fixture('canvas.json'), ed: await fixture('ed.json'), handbook: await fixture('handbook.json') };
}

describe('UniMelb golden: prompts and wording', () => {
  it('analysis prompt for the synthetic course', async () => {
    const { course, canvas, ed, handbook } = await collected();
    await expect(buildAnalysisPrompt({ course, term: course.term, canvas, ed, handbook })).toMatchFileSnapshot(golden('analysis-prompt.txt'));
  });

  it('repair prompt and validation issues for an invalid reply', async () => {
    const { course, canvas, ed, handbook } = await collected();
    const reply = await fixture('outputs/2.json');
    reply.document.assessments[1].refs = [{ platform: 'canvas', id: '999' }];
    reply.document.assessments[0].refs = [{ platform: 'handbook', id: 'Not a component' }];
    reply.document.course.code = 'SYNT99999';
    const text = JSON.stringify(reply);
    const validation = validateAnalysis(text, { course, canvas, ed, handbook });
    expect(validation.valid).toBe(false);
    await expect(json({ issues: validation.issues, repair: repairPrompt(validation.issues, text) })).toMatchFileSnapshot(golden('repair-prompt.json'));
  });

  it('chat system prompts in both languages and modes, and chat tool descriptions', async () => {
    const prompts = Object.fromEntries((['zh', 'en'] as const).flatMap(language => [
      [`context-${language}`, chatSystemPrompt(language, 'context')], [`tools-${language}`, toolSystemPrompt(language)],
    ]));
    await expect(json(prompts)).toMatchFileSnapshot(golden('chat-system-prompts.json'));
    await expect(json(toolDefinitions().map(({ name, title, description }) => ({ name, title, description })))).toMatchFileSnapshot(golden('chat-tool-descriptions.json'));
  });
});

describe('UniMelb golden: reasons, folders and hashes', () => {
  it('settle reasons for every collection-flag combination, with a parsable and an unparsable Handbook', async () => {
    const { course, canvas, ed, handbook } = await collected();
    const text = JSON.stringify(await fixture('outputs/2.json'));
    const flags = ['canvasFailed', 'canvasUnpaginated', 'edFailed', 'edPartial', 'handbookFailed'] as const;
    const rows: unknown[] = [];
    for (const variant of ['parsable', 'unparsable'] as const) {
      const data = { canvas, ed, handbook: variant === 'parsable' ? handbook : { ...handbook, text: 'Assessment\nNo table here' } };
      const validation = validateAnalysis(text, { course, ...data });
      for (let mask = 0; mask < 1 << flags.length; mask++) {
        // The named flags of the recording, in the per-source form settleCourse takes since generic-adapters PR 3.
        const on = (flag: (typeof flags)[number]) => Boolean(mask & (1 << flags.indexOf(flag)));
        const collection = {
          canvas: { failed: on('canvasFailed'), unpaginated: on('canvasUnpaginated') }, ed: { failed: on('edFailed'), partial: on('edPartial') }, handbook: { failed: on('handbookFailed') },
        };
        const settled = settleCourse({ result: { exitCode: 0, lastMessage: text, usage: null }, validation, collection, data, previous: null });
        rows.push({ handbook: variant, flags: flags.filter((_, index) => mask & (1 << index)), status: settled.status, reason: settled.reason });
      }
    }
    const { canvas: c, ed: e, handbook: h } = { canvas, ed, handbook };
    const failedValidation = validateAnalysis('not json', { course, canvas: c, ed: e, handbook: h });
    rows.push({ case: 'model exit 1', ...pick(settleCourse({ result: { exitCode: 1, lastMessage: '', usage: null, error: '' }, validation: failedValidation, collection: {}, data: { canvas, ed, handbook }, previous: null })) });
    rows.push({ case: 'invalid reply', ...pick(settleCourse({ result: { exitCode: 0, lastMessage: 'not json', usage: null }, validation: failedValidation, collection: {}, data: { canvas, ed, handbook }, previous: null })) });
    await expect(json(rows)).toMatchFileSnapshot(golden('settle-reasons.json'));
  });

  it('Desktop folders and term labels', async () => {
    const terms = ['2026 Semester 2', 'Semester 1 2026', '2026 Sem 1', 'Summer Term 2026', 'Default Term', '', null, '2026/27 Winter: <x>'];
    const rows = terms.map(term => ({ term, label: termLabel(term), folder: courseFolder('<Desktop>', { id: '900001', subjectCode: 'SYNT10001', term }) }));
    await expect(json(rows)).toMatchFileSnapshot(golden('desktop-folders.json'));
  });

  it('collect and validate input hashes', async () => {
    const sources = { canvas: { file: '/r/canvas.json', sha256: 'c', exitCode: 0 }, ed: { file: '/r/ed.json', sha256: 'e', exitCode: 1 }, handbook: { file: '/r/handbook.json', sha256: 'h', exitCode: 0 } };
    // The collect hash is the one recorded value that changed on purpose: generic-adapters PR 3 added the setup to the
    // collect inputs and bumped COLLECT_VERSION (design §1, decision #464). The validate hash is unchanged.
    await expect(json({
      collect: collectInputHash({ courseId: '900001', code: 'SYNT10001', term: '2026 Semester 2', institution: 'unimelb', canvasOrigin: CANVAS, edRegion: 'auto', sources: ['canvas', 'ed', 'handbook'] }),
      validate: validateInputHash({ analyseArtifact: 'a', sources, previous: null }),
    })).toMatchFileSnapshot(golden('input-hashes.json'));
  });
});

const pick = ({ status, reason }: { status: string; reason: string }) => ({ status, reason });

// ---- Collectors on synthetic responses -------------------------------------------------------------------------
const CANVAS = 'https://canvas.lms.unimelb.edu.au';
const coursesUrl = `${CANVAS}/api/v1/courses?enrollment_state=active&include[]=term&per_page=100`;
const coursesPage2 = `${CANVAS}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=2&per_page=100`;
const discoverScenario: CollectorScenario = {
  now: '2026-10-30T01:02:03.000Z',
  pages: {
    [coursesUrl]: {
      status: 200, link: `<${coursesPage2}>; rel="next", <${coursesUrl}>; rel="first"`,
      body: `while(1);${JSON.stringify([
        { id: 900001, name: 'Synthetic Course', course_code: 'SYNT10001_2026_SM2', term: { name: '2026 Semester 2' } },
        { id: 900002, name: 'Synthetic Community', term: { name: 'Default Term' } },
      ])}`,
    },
    [coursesPage2]: {
      status: 200, link: null,
      body: JSON.stringify([
        { id: 900003, name: '', course_code: 'SYNT30003_2026_SM1', term: { name: '2026 Semester 1' } },
        { id: 900001, name: 'Synthetic Course (again)', course_code: 'SYNT10001_2026_SM2', term: { name: '2026 Semester 2' } },
        { id: 900004, course_code: 'synt40004', term: null },
      ]),
    },
  },
};
const coursePrefix = `${CANVAS}/api/v1/courses/900001/`;
const assignmentsUrl = `${coursePrefix}assignments?include%5B%5D=submission&per_page=100`;
const assignmentsPage2 = `${coursePrefix}assignments?include%5B%5D=submission&page=2&per_page=100`;
const courseScenario: CollectorScenario = {
  now: '2026-10-30T01:02:03.000Z',
  pages: {
    [`${coursePrefix}assignment_groups?per_page=100`]: {
      status: 200, link: null,
      body: JSON.stringify([{ id: 501, name: 'Weekly Quizzes', group_weight: 20, rules: {}, extra: 'dropped' }, { id: 502, name: 'Assignments', group_weight: 30 }]),
    },
    [assignmentsUrl]: {
      status: 200, link: `<${assignmentsPage2}>; rel="next"`,
      body: JSON.stringify([{ id: 7101, name: 'Quiz 1', assignment_group_id: 501, points_possible: 10, due_at: '2026-08-07T13:59:00Z', html_url: `${CANVAS}/courses/900001/assignments/7101`, submission: { score: 8, workflow_state: 'graded', submitted_at: '2026-08-06T00:00:00Z', body: 'dropped' } }]),
    },
    [assignmentsPage2]: {
      status: 200, link: null,
      body: JSON.stringify([{ id: 7201, name: 'Assignment 1', assignment_group_id: 502, points_possible: 30 }]),
    },
  },
};
const handbookUrl = 'https://handbook.unimelb.edu.au/2026/subjects/synt10001/assessment';
const handbookScenario: CollectorScenario = {
  now: '2026-10-30T01:02:03.000Z',
  texts: { [handbookUrl]: 'SYNT10001 Synthetic Course\nAssessment\nDescription\tTiming\tPercentage\nProject report\tWeek 10\t30%\nFinal examination\tExamination period\t70%' },
};
const edScenario: CollectorScenario = {
  now: '2026-10-30T01:02:03.000Z',
  edstem: {
    'units list --json': [
      { id: 42, code: 'SYNT10001', year: 2026, session: 'Semester 2' },
      { id: 43, code: 'SYNT10001X', year: 2026, session: 'Semester 2' },
      { id: 44, code: 'SYNT10001', year: 2026, session: 'Semester 1' },
      { id: 45, code: 'SYNT10002', year: 2026, session: 'Semester 2' },
    ],
    'lessons list 42 --json --module all --state all --status all': [
      { id: 3001, courseId: 42, title: 'Assignment 1 submission', moduleName: 'Assignments', dueAt: '2026-08-28T13:59:00Z', status: 'completed' },
      { id: 3005, courseId: 42, title: 'Subject overview', moduleName: 'Welcome', dueAt: null, status: null },
      { id: 3006, courseId: 42, title: 'Week 1 Workshop', moduleName: 'Workshops' },
      { id: 3007, courseId: 99, title: 'Other course project', moduleName: 'Projects' },
    ],
    'lessons show 3005 --json': { slides: [{ id: 11, title: 'Subject overview' }, { id: 12, title: 'Other' }] },
    'lessons show 3006 --json': { slides: [{ id: 13, title: 'Welcome to the workshop' }] },
    'slides show 11 --json': { lessonId: 3005, courseId: 42, content: '<p>Assessment:  <b>Project</b> 30%</p>' },
    'slides show 13 --json': { lessonId: 3006, courseId: 42, content: '<p>Workshop rules</p>' },
  },
  scores: { source: 'edstem', results: [{ lessonId: '3001', status: 'graded', score: 24, maxScore: 30, submittedAt: '2026-08-27T09:00:00Z', durationMs: 0 }] },
};
const scoresScenario: CollectorScenario = {
  edstem: { 'auth status --json': { authenticated: true, user: { id: 501 }, region: 'au' } },
  fetch: {
    'https://edstem.org/api/lessons/3001/attempts/501': { json: { attempts: [{ id: 9, user_id: 501, lesson_id: 3001, submitted_at: '2026-08-27T09:00:00Z' }], final_id: 9 } },
    'https://edstem.org/api/lessons/3001/marking_status?attempt=9': { json: { attempt_result: { user_id: 501, mark: 24 }, slide_totals: { a: 30 }, lesson_markable_marking_status: [{ unmarked_user_ids: [] }] } },
    'https://edstem.org/api/lessons/3002/attempts/501': { status: 403, json: {} },
  },
};

/** Collector entry points as they were before the move; the old paths must keep working (shims). */
export const COLLECTOR_SCRIPTS = { canvas: 'scripts/canvas-background.mjs', handbook: 'scripts/collect-handbook.mjs', ed: 'scripts/collect-ed-course.mjs', scores: 'scripts/edstem-scores.mjs' };

describe('UniMelb golden: collectors on synthetic responses', () => {
  it('Canvas discovery: AppleScript calls and written course list', async () => {
    const run = await runCollectorScript(COLLECTOR_SCRIPTS.canvas, ['discover', '<out>'], discoverScenario);
    expect(run.code, run.stderr).toBe(0);
    const { canvasOrigin, institution, ...written } = JSON.parse(run.output!);
    expect(written.courses).toEqual(normalizeCourses(JSON.parse(discoverScenario.pages![coursesUrl].body.slice('while(1);'.length)).concat(JSON.parse(discoverScenario.pages![coursesPage2].body))));
    // The two fields generic-adapters PR 3 added are left out of the recording and asserted here (design §4).
    expect({ canvasOrigin, institution }).toEqual({ canvasOrigin: CANVAS, institution: 'unimelb' });
    await expect(json(written)).toMatchFileSnapshot(golden('canvas-discover.json'));
    await expect(json({ stdout: run.stdout, stderr: run.stderr, ...callTranscript(run.calls) })).toMatchFileSnapshot(golden('canvas-discover-calls.json'));
  });

  it('Canvas course: groups and paginated assignments', async () => {
    const run = await runCollectorScript(COLLECTOR_SCRIPTS.canvas, ['900001', '<out>'], courseScenario);
    expect(run.code, run.stderr).toBe(0);
    await expect(run.output).toMatchFileSnapshot(golden('canvas-course.json'));
    await expect(json({ stdout: run.stdout, stderr: run.stderr, ...callTranscript(run.calls) })).toMatchFileSnapshot(golden('canvas-course-calls.json'));
  });

  it('Canvas failures: foreign next link, redirect, HTTP 503 (exit 75)', async () => {
    const foreign = structuredClone(courseScenario);
    foreign.pages![assignmentsUrl].link = '<https://elsewhere.example.org/api/v1/courses/900001/assignments?page=2>; rel="next"';
    const redirect: CollectorScenario = { ...courseScenario, state: { [`${coursePrefix}assignment_groups?per_page=100`]: 'redirect' } };
    const busy = structuredClone(courseScenario);
    busy.pages![`${coursePrefix}assignment_groups?per_page=100`] = { status: 503, body: '', link: null };
    const rows = [];
    for (const [name, scenario] of [['foreign', foreign], ['redirect', redirect], ['busy', busy]] as const) {
      const run = await runCollectorScript(COLLECTOR_SCRIPTS.canvas, ['900001', '<out>'], scenario);
      rows.push({ name, code: run.code, stderr: run.stderr, written: run.output !== null, closes: run.calls.filter(call => /close t$/m.test(String(call.script))).length });
    }
    await expect(json(rows)).toMatchFileSnapshot(golden('canvas-failures.json'));
  });

  it('Handbook: assessment page text, and HTTP 503 (exit 75)', async () => {
    const run = await runCollectorScript(COLLECTOR_SCRIPTS.handbook, ['SYNT10001', '2026', '<out>'], handbookScenario);
    expect(run.code, run.stderr).toBe(0);
    await expect(run.output).toMatchFileSnapshot(golden('handbook.json'));
    const busy = await runCollectorScript(COLLECTOR_SCRIPTS.handbook, ['SYNT10001', '2026', '<out>'], { texts: { [handbookUrl]: 'Service unavailable' }, navigationStatus: { [handbookUrl]: 503 } });
    await expect(json({ stdout: run.stdout, ...callTranscript(run.calls), busy: { code: busy.code, stderr: busy.stderr, written: busy.output !== null } })).toMatchFileSnapshot(golden('handbook-calls.json'));
  });

  it('Ed: unit match, lessons, scores and introductions', async () => {
    const run = await runCollectorScript(COLLECTOR_SCRIPTS.ed, ['SYNT10001', '2026 Semester 2', '<out>'], edScenario);
    expect(run.code, run.stderr).toBe(0);
    await expect(run.output).toMatchFileSnapshot(golden('ed.json'));
    const ambiguous = structuredClone(edScenario);
    (ambiguous.edstem!['units list --json'] as unknown[]).push({ id: 46, code: 'synt10001', year: 2026, session: 'Sem 2' });
    const twice = await runCollectorScript(COLLECTOR_SCRIPTS.ed, ['SYNT10001', '2026 Semester 2', '<out>'], ambiguous);
    const noSemester = await runCollectorScript(COLLECTOR_SCRIPTS.ed, ['SYNT10001', '2026 Summer', '<out>'], edScenario);
    const none = await runCollectorScript(COLLECTOR_SCRIPTS.ed, ['SYNT20002', '2026 Semester 2', '<out>'], edScenario);
    await expect(json({
      stdout: run.stdout, calls: run.calls,
      ambiguous: { code: twice.code, stderr: twice.stderr }, noSemester: { code: noSemester.code, stderr: noSemester.stderr.split('\n').find(line => line.startsWith('Error')) },
      notFound: { code: none.code, output: none.output && JSON.parse(none.output) },
    })).toMatchFileSnapshot(golden('ed-calls.json'));
  });

  it('Ed scores: only the owner\'s final submissions through the CLI token', async () => {
    const run = await runCollectorScript(COLLECTOR_SCRIPTS.scores, ['3001', '3002'], scoresScenario, { EDSTEM_TOKEN: 'synthetic-token' });
    expect(run.code, run.stderr).toBe(0);
    await expect(json({ stdout: JSON.parse(run.stdout), calls: run.calls })).toMatchFileSnapshot(golden('ed-scores.json'));
  });
});

// ---- The collect stage ------------------------------------------------------------------------------------------
describe('UniMelb golden: collect stage', () => {
  let project: Project | undefined;
  afterEach(async () => { await project?.cleanup(); project = undefined; });

  it('collector arguments, run-directory files, prompt and course reasons with fake collectors', async () => {
    const courses = [syntheticCourse(1), { id: '900002', code: 'SYNT20002', term: '2026 Summer' }];
    project = await createProject(courses);
    const store = await openStore(project.projectDir, () => START);
    const fakes = fakeCollectors(courses, { '900001:ed': { exit: [1] } });
    const requests: unknown[] = [];
    const dir = project.projectDir;
    const runCollector = async (request: CollectorRequest) => {
      requests.push({ source: request.source, args: request.args.map(arg => (arg.startsWith(dir) ? relative(dir, arg) : arg)) });
      return fakes.runCollector(request);
    };
    const prompts: string[] = [];
    const model = fakeModel(courses);
    const callModel: typeof model.callModel = async (config, prompt, options) => { prompts.push(prompt); return model.callModel(config, prompt, options); };
    const pipeline = pipelineFor(project, store, { runCollector, callModel }, { ids: ['run-1'] });
    await pipeline.start(['900001', '900002']);
    await pipeline.idle();
    const runFiles: Record<string, string> = {};
    for (const course of courses) {
      const courseRun = join(dir, '.local', 'lms', 'runs', 'run-1', course.id);
      for (const name of (await readdir(courseRun)).sort()) {
        const content = await readFile(join(courseRun, name), 'utf8');
        runFiles[`${course.id}/${name}`] = content.startsWith('{"status":"unavailable"') ? content : `<fixture ${content.length} bytes>`;
      }
    }
    const status = pipeline.status();
    store.close();
    await expect(json({
      requests, runFiles, promptsContainCodes: prompts.map(prompt => courses.filter(course => prompt.includes(`"code":"${course.code}"`)).map(course => course.code)),
      courses: status.courses.map(({ id, code, status: state, reason }) => ({ id, code, status: state, reason })),
    })).toMatchFileSnapshot(golden('collect-stage.json'));
  });
});
