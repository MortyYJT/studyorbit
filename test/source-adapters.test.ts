import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatSystemPrompt } from '../scripts/lib/chat-context.mjs';
import { buildAnalysisPrompt } from '../scripts/lib/course-analysis.mjs';
import { filterSubjects, normalizeCourses } from '../scripts/lib/course-list.mjs';
import { parseHandbookComponents as fromParse } from '../scripts/institutions/unimelb/handbook-parse.mjs';
import { courseFolder, limiterKey, spawnCollector, type CollectorRequest } from '../scripts/lib/sync-stages.mjs';
import { unimelb } from '../scripts/institutions/unimelb/index.mjs';
import { handbookSource } from '../scripts/institutions/unimelb/handbook-source.mjs';
import { canvasOrigin, collectorConfig, DEFAULT_SOURCE_CONFIG, MISSING_CONFIG_OFF_MACOS, readSourceConfig, SOURCE_CONFIG_ENV, sourceConfigEnv } from '../scripts/sources/config.mjs';
import { canvasSource, edSource, LEGACY_SOURCE_IDS, resolveSourceSetup, resolveSources } from '../scripts/sources/registry.mjs';
import type { CourseSource } from '../scripts/sources/types.d.mts';
import { runCollectorScript } from './collector-harness.ts';
import { createProject, fakeCollectors, fakeModel, openStore, pipelineFor, START, syntheticCourse, type Project } from './sync-fakes.ts';

// Course sources, the collector configuration and the UniMelb institution plugin (openspec change generic-adapters,
// design §1–§4, decisions #440–#443). Synthetic data only; collectors run against fakes (test/collector-harness.ts).

describe('collector configuration (STUDYORBIT_SOURCE_CONFIG)', () => {
  it('defaults to today\'s setup when missing, refusing to guess the browser off macOS', () => {
    expect(readSourceConfig({ env: {}, platform: 'darwin', needsBrowser: true })).toEqual({
      version: 1, institution: 'unimelb', canvasOrigin: 'https://canvas.lms.unimelb.edu.au', browser: 'edge-applescript', browserPath: null, edRegion: 'auto', profileDir: null,
    });
    expect(() => readSourceConfig({ env: {}, platform: 'linux', needsBrowser: true })).toThrow(MISSING_CONFIG_OFF_MACOS);
    expect(readSourceConfig({ env: {}, platform: 'linux' }).institution).toBe('unimelb');
  });

  it('parses a valid variable and refuses an invalid one instead of falling back', () => {
    const env = sourceConfigEnv(DEFAULT_SOURCE_CONFIG);
    expect(Object.keys(env)).toEqual([SOURCE_CONFIG_ENV]);
    expect(readSourceConfig({ env, platform: 'linux', needsBrowser: true })).toEqual(DEFAULT_SOURCE_CONFIG);
    const bad = (value: unknown) => () => readSourceConfig({ env: { [SOURCE_CONFIG_ENV]: typeof value === 'string' ? value : JSON.stringify(value) }, platform: 'darwin' });
    expect(bad('{not json')).toThrow('不是有效的 JSON');
    for (const change of [{ version: 2 }, { institution: 'elsewhere' }, { browser: 'safari' }, { canvasOrigin: 'http://canvas.example.edu' }, { edRegion: 'mars' }, { token: 'x' },
      { browserPath: '/Applications/Chrome' }, { browser: 'cdp-chrome', browserPath: 'relative/chrome' }, { profileDir: '/tmp/p' }]) {
      expect(bad({ ...DEFAULT_SOURCE_CONFIG, ...change })).toThrow(`${SOURCE_CONFIG_ENV} 无效`);
    }
  });

  it('accepts the generic institution, every Ed region and the CDP browsers with an absolute path (generic-adapters PR 3)', () => {
    const generic = { ...DEFAULT_SOURCE_CONFIG, institution: 'generic' as const, canvasOrigin: 'https://canvas.example.edu', browser: 'cdp-edge' as const, browserPath: '/opt/edge/msedge', edRegion: 'us' as const };
    expect(readSourceConfig({ env: sourceConfigEnv(generic), platform: 'linux', needsBrowser: true })).toEqual(generic);
    for (const edRegion of ['auto', 'au', 'us', 'eu'] as const) expect(readSourceConfig({ env: sourceConfigEnv({ ...DEFAULT_SOURCE_CONFIG, edRegion }) }).edRegion).toBe(edRegion);
    expect(collectorConfig({ institution: 'generic', canvasOrigin: 'https://canvas.example.edu', browser: 'chrome-applescript', edRegion: 'eu' }))
      .toEqual({ version: 1, institution: 'generic', canvasOrigin: 'https://canvas.example.edu', browser: 'chrome-applescript', browserPath: null, edRegion: 'eu', profileDir: null });
  });

  it('ignores the removed STUDYORBIT_BROWSER override: the settings file chooses the browser now', () => {
    expect(readSourceConfig({ env: { STUDYORBIT_BROWSER: 'chrome-applescript' }, platform: 'darwin', needsBrowser: true })).toEqual(DEFAULT_SOURCE_CONFIG);
    expect(readSourceConfig({ env: { STUDYORBIT_BROWSER: 'safari' }, platform: 'darwin', needsBrowser: true })).toEqual(DEFAULT_SOURCE_CONFIG);
  });

  it('accepts only https origins without user, path, query, fragment or IP address', () => {
    expect(canvasOrigin('https://canvas.example.edu')).toBe('https://canvas.example.edu');
    expect(canvasOrigin('https://Canvas.Example.edu/')).toBe('https://canvas.example.edu');
    for (const value of ['http://canvas.example.edu', 'https://user:pw@canvas.example.edu', 'https://canvas.example.edu/login', 'https://canvas.example.edu/?a=1',
      'https://canvas.example.edu/#x', 'https://10.0.0.1', 'https://[::1]', 'https://localhost', 'not a url']) expect(() => canvasOrigin(value), value).toThrow();
  });
});

describe('sources', () => {
  it('resolves Canvas, Ed and the institution\'s framework source in order, with today\'s labels, limiters and placeholders', () => {
    const setup = resolveSourceSetup();
    expect(setup.sources.map(source => source.id)).toEqual([...LEGACY_SOURCE_IDS]);
    expect(resolveSources(DEFAULT_SOURCE_CONFIG, { ...unimelb, framework: null })).toEqual([canvasSource, edSource]);
    expect(setup.sources.map(source => [source.label, limiterKey(source)])).toEqual([['Canvas', 'browser'], ['Ed', 'ed'], ['Handbook', 'browser']]);
    // Byte for byte the placeholders of the staged pipeline before the move.
    expect(setup.sources.map(source => JSON.stringify(source.placeholder()))).toEqual([
      '{"status":"unavailable","reason":"Canvas 采集不可用"}',
      '{"status":"unavailable","lessons":[],"scores":[],"reason":"Ed 采集不可用"}',
      '{"status":"unavailable","reason":"Handbook 采集不可用"}',
    ]);
    expect(setup.sources.flatMap(source => source.platforms)).toEqual(['canvas', 'canvas-group', 'ed', 'handbook']);
    expect(JSON.parse(setup.context.env[SOURCE_CONFIG_ENV]!)).toEqual(DEFAULT_SOURCE_CONFIG);
    expect(canvasSource.discover(setup.context, '/o.json')).toEqual({ script: 'sources/canvas/collect.mjs', args: ['discover', '/o.json'], env: setup.context.env });
  });

  it('builds course links on the given Canvas origin', () => {
    expect(normalizeCourses([{ id: 7, name: 'A', course_code: 'X', term: { name: 'T' } }], 'https://canvas.example.edu'))
      .toEqual([{ id: '7', name: 'A', code: 'X', term: 'T', url: 'https://canvas.example.edu/courses/7' }]);
  });
});

describe('the unimelb institution', () => {
  it('keeps today\'s subject codes, terms, folders and Ed session matching', () => {
    expect(unimelb.subjectCode(' synt10001_2026_SM2')).toBe('SYNT10001');
    expect(unimelb.subjectCode('SYNT1000')).toBeNull();
    expect(unimelb.isSubjectCode('SYNT10001')).toBe(true);
    expect(unimelb.isSubjectCode('synt10001')).toBe(false);
    expect(filterSubjects([{ id: '1', code: 'SYNT10001_X' }, { id: '2', code: null }], unimelb)).toEqual([{ id: '1', code: 'SYNT10001_X', subjectCode: 'SYNT10001' }]);
    expect(unimelb.termKey('2026 Semester 2')).toEqual({ year: '2026', session: '2' });
    expect(unimelb.termKey('2026 Summer')).toEqual({ year: null, session: null });
    expect(unimelb.edSessionMatches('Sem 2', { year: '2026', session: '2' })).toBe(true);
    expect(unimelb.edSessionMatches('Semester 22', { year: '2026', session: '2' })).toBe(false);
    expect(unimelb.courseFolder({ term: 'Semester 2 2026', subjectCode: 'ABCD10001' })).toEqual(['墨尔本大学 Semester 2 2026', 'ABCD10001']);
    expect(courseFolder('/D', { id: '1', subjectCode: 'ABCD10001', term: '2026 Semester 2' })).toBe(join('/D', '墨尔本大学 2026 S2', 'ABCD10001'));
    expect(unimelb.defaults.timeZone).toBe('Australia/Melbourne');
  });

  it('holds today\'s wording and the Handbook framework source unchanged', async () => {
    const fixture = async (name: string) => JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'synthetic-course', name), 'utf8'));
    const [course] = filterSubjects([await fixture('course.json')]);
    const prompt = buildAnalysisPrompt({ course: course!, term: course!.term as string, canvas: await fixture('canvas.json'), ed: await fixture('ed.json'), handbook: await fixture('handbook.json') });
    expect(prompt).toContain(`1. ${unimelb.wording.sourcesRule}\n`);
    expect(prompt).toContain(handbookSource.promptRules.refs);
    expect(prompt).toContain(handbookSource.promptRules.quote);
    expect(chatSystemPrompt('zh').split('\n')[0]).toBe(unimelb.wording.assistantIntro.zh);
    expect(chatSystemPrompt('en').split('\n')[0]).toBe(unimelb.wording.assistantIntro.en);
    expect(unimelb.framework).toBe(handbookSource);
    expect(handbookSource.parseComponents).toBe(fromParse);
    expect(handbookSource.parseComponents('Project report\tWeek 10\t30%')).toEqual([{ name: 'Project report', percent: 30, rowTexts: ['Project report Week 10 30%'] }]);
    expect(handbookSource.origins).toEqual(['https://handbook.unimelb.edu.au']);
  });
});

describe('collectors through the new entry points and the configuration', () => {
  const discover = {
    now: '2026-10-30T01:02:03.000Z',
    pages: { 'https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=100': { status: 200, link: null, body: '[{"id":900001,"name":"Synthetic Course","course_code":"SYNT10001_2026_SM2","term":{"name":"2026 Semester 2"}}]' } },
  };

  it('writes the same discovery file through the shim and the new path, with or without the configuration', async () => {
    const old = await runCollectorScript('scripts/canvas-background.mjs', ['discover', '<out>'], discover);
    const moved = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], discover, sourceConfigEnv(DEFAULT_SOURCE_CONFIG));
    expect(old.code, old.stderr).toBe(0);
    expect(moved.code, moved.stderr).toBe(0);
    expect(moved.output).toBe(old.output);
    expect(moved.calls).toEqual(old.calls);
  });

  it('exits 1 off macOS without the configuration, and on an invalid one, before any browser call', async () => {
    const offMac = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], { ...discover, platform: 'linux' });
    expect([offMac.code, offMac.calls]).toEqual([1, []]);
    expect(offMac.stderr).toContain(MISSING_CONFIG_OFF_MACOS);
    const handbook = await runCollectorScript('scripts/institutions/unimelb/handbook-collect.mjs', ['SYNT10001', '2026', '<out>'], { platform: 'win32' });
    expect([handbook.code, handbook.calls]).toEqual([1, []]);
    expect(handbook.stderr).toContain(MISSING_CONFIG_OFF_MACOS);
    const invalid = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], discover, { [SOURCE_CONFIG_ENV]: '{"version":1}' });
    expect([invalid.code, invalid.calls]).toEqual([1, []]);
    expect(invalid.stderr).toContain(`${SOURCE_CONFIG_ENV} 无效`);
    // A configured Edge bridge is unavailable off macOS too.
    const configured = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], { ...discover, platform: 'linux' }, sourceConfigEnv(DEFAULT_SOURCE_CONFIG));
    expect([configured.code, configured.calls]).toEqual([1, []]);
    expect(configured.stderr).toContain('只能在 macOS 上使用');
  });

  it('keeps the collectors\' handling of a tab that cannot be closed', async () => {
    const handbookUrl = 'https://handbook.unimelb.edu.au/2026/subjects/synt10001/assessment';
    // Handbook: the text is kept and written; the close message follows the result.
    const handbook = await runCollectorScript('scripts/collect-handbook.mjs', ['SYNT10001', '2026', '<out>'], {
      closeError: 'tab gone', texts: { [handbookUrl]: 'SYNT10001 Assessment' },
    });
    expect([handbook.code, handbook.stderr]).toEqual([0, '无法关闭 Handbook 后台标签页，请手动关闭。\n']);
    expect(JSON.parse(handbook.output!)).toMatchObject({ status: 'available', text: 'SYNT10001 Assessment' });
    // Canvas: a failed close fails the collector; closing is tried once more; the failure is reported first.
    const canvas = await runCollectorScript('scripts/canvas-background.mjs', ['discover', '<out>'], { ...discover, closeError: 'tab gone' });
    expect([canvas.code, canvas.output]).toEqual([1, null]);
    expect(canvas.stderr).toBe('Canvas 后台采集失败：tab gone。如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。\n无法关闭本次后台采集标签页，请手动关闭。\n');
    expect(canvas.calls.filter(call => /close t$/m.test(String(call.script)))).toHaveLength(2);
    // A failure with a tab that cannot be closed: the failure first, then the close message.
    const redirect = await runCollectorScript('scripts/canvas-background.mjs', ['discover', '<out>'], {
      ...discover, closeError: 'tab gone', state: { [Object.keys(discover.pages)[0]!]: 'redirect' },
    });
    expect(redirect.stderr).toBe('Canvas 后台采集失败：Canvas 登录可能已失效或页面跳转。如提示 JavaScript from Apple Events，请在 Edge 开发者菜单允许后重试。\n无法关闭本次后台采集标签页，请手动关闭。\n');
  });

  it('drives only Google Chrome when Chrome is chosen, and fails without starting it when it is not open', async () => {
    const chrome = { ...DEFAULT_SOURCE_CONFIG, browser: 'chrome-applescript' as const };
    const run = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], discover, sourceConfigEnv(chrome));
    expect(run.code, run.stderr).toBe(0);
    const scripts = run.calls.map(call => String(call.script));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).toMatch(/application "Google Chrome"/);
      expect(script).not.toMatch(/Edge|Microsoft/);
    }
    // The same courses as through Edge.
    const edge = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], discover);
    expect(run.output).toBe(edge.output);
    // The temporary STUDYORBIT_BROWSER override of PR 2 is gone: by hand, without the configuration, Edge is used.
    const byHand = await runCollectorScript('scripts/canvas-background.mjs', ['discover', '<out>'], discover, { STUDYORBIT_BROWSER: 'chrome-applescript' });
    expect(byHand.calls.map(call => String(call.script))).toEqual(edge.calls.map(call => String(call.script)));

    const closed = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], { ...discover, running: false }, sourceConfigEnv(chrome));
    expect([closed.code, closed.output]).toEqual([1, null]);
    expect(closed.calls.map(call => String(call.script))).toEqual(['on run argv\n return application "Google Chrome" is running\nend run']);
    expect(closed.stderr).toContain('请先打开 Google Chrome 并登录');
    expect(closed.stderr).toContain('View → Developer → Allow JavaScript from Apple Events');
    const handbook = await runCollectorScript('scripts/collect-handbook.mjs', ['SYNT10001', '2026', '<out>'], { running: false }, sourceConfigEnv(chrome));
    expect([handbook.code, handbook.calls.length]).toEqual([1, 1]);
    expect(handbook.stderr).toBe('Handbook 采集不可用：请先打开 Google Chrome 并登录\n');
  });

  it('runs Ed off macOS without the configuration (Ed never needs the browser)', async () => {
    const run = await runCollectorScript('scripts/sources/ed/collect.mjs', ['SYNT10001', '2026 Semester 2', '<out>'], {
      platform: 'linux', edstem: { 'units list --json': [] },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.output!)).toMatchObject({ status: 'not_found', code: 'SYNT10001' });
  });

  it('matches the Ed unit code literally and case-insensitively', async () => {
    const units = [{ id: 1, code: 'synt10001', year: 2026, session: 'Semester 2' }, { id: 2, code: 'SYNT100012', year: 2026, session: 'Semester 2' }];
    const run = await runCollectorScript('scripts/sources/ed/collect.mjs', ['SYNT10001', '2026 Semester 2', '<out>'], {
      edstem: { 'units list --json': units, 'lessons list 1 --json --module all --state all --status all': [] },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.output!)).toMatchObject({ status: 'complete', unitId: '1' });
  });
});

describe('another Canvas and the Ed regions (generic-adapters PR 3)', () => {
  const OTHER = 'https://canvas.example.edu';
  const other = { ...DEFAULT_SOURCE_CONFIG, institution: 'generic' as const, canvasOrigin: OTHER };
  const page = (body: unknown, link: string | null = null) => ({ status: 200, link, body: JSON.stringify(body) });

  it('discovers on the configured origin, records it with the institution, and links courses there', async () => {
    const url = `${OTHER}/api/v1/courses?enrollment_state=active&include[]=term&per_page=100`;
    const run = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], {
      now: '2026-10-30T01:02:03.000Z', pages: { [url]: page([{ id: 77, name: 'Intro', course_code: 'CS101', term: { name: 'Fall 2026' } }]) },
    }, sourceConfigEnv(other));
    expect(run.code, run.stderr).toBe(0);
    const written = JSON.parse(run.output!);
    expect(written).toMatchObject({ canvasOrigin: OTHER, institution: 'generic', source: url, courses: [{ id: '77', code: 'CS101', term: 'Fall 2026', url: `${OTHER}/courses/77` }] });
    expect(run.calls.filter(call => call.kind === 'osascript' && Array.isArray(call.argv) && String(call.argv[0]).startsWith('https://'))
      .every(call => String((call.argv as string[])[0]).startsWith(`${OTHER}/`))).toBe(true);
  });

  it('follows the next page on the same origin and path only', async () => {
    const prefix = `${OTHER}/api/v1/courses/77/`;
    const groups = `${prefix}assignment_groups?per_page=100`;
    const assignments = `${prefix}assignments?include%5B%5D=submission&per_page=100`;
    const next = `${prefix}assignments?include%5B%5D=submission&page=2&per_page=100`;
    const scenario = { pages: { [groups]: page([]), [assignments]: page([{ id: 1, name: 'A' }], `<${next}>; rel="next"`), [next]: page([{ id: 2, name: 'B' }]) } };
    const ok = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['77', '<out>'], scenario, sourceConfigEnv(other));
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(ok.output!).assignments.map((item: { id: number }) => item.id)).toEqual([1, 2]);
    for (const foreign of ['https://canvas.lms.example.org/api/v1/courses/77/assignments?page=2', `${OTHER}/api/v1/courses/78/assignments?page=2`]) {
      const refused = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['77', '<out>'], { pages: { ...scenario.pages, [assignments]: page([{ id: 1 }], `<${foreign}>; rel="next"`) } }, sourceConfigEnv(other));
      expect([refused.code, refused.output]).toEqual([1, null]);
      expect(refused.stderr).toContain('Canvas 下一页链接不属于当前接口');
    }
  });

  it('stops before any browser call for the CDP bridge, which is not built yet', async () => {
    const run = await runCollectorScript('scripts/sources/canvas/collect.mjs', ['discover', '<out>'], { platform: 'linux' }, sourceConfigEnv({ ...other, browser: 'cdp-chrome' }));
    expect([run.code, run.calls, run.output]).toEqual([1, [], null]);
    expect(run.stderr).toContain('专用浏览器（CDP）还没有实现');
  });

  const units = { 'units list --json': [{ id: 5, code: 'CS101', year: 2026, session: 'Fall' }, { id: 6, code: 'CS.1019', year: 2026, session: 'Fall' }, { id: 7, code: 'CSX101', year: 2026, session: 'Fall' }],
    'lessons list 5 --json --module all --state all --status all': [{ id: 9, courseId: 5, title: 'Week 1 notes' }] };

  it('makes Ed unavailable with no Ed request when the explicit region differs from the CLI sign-in', async () => {
    const run = await runCollectorScript('scripts/sources/ed/collect.mjs', ['CS101', 'Fall 2026', '<out>'], {
      edstem: { ...units, 'auth status --json': { authenticated: true, user: { id: 1 }, region: 'au' } },
    }, sourceConfigEnv({ ...other, edRegion: 'us' }));
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.output!)).toMatchObject({ status: 'unavailable', reason: 'Ed 登录区域与设置不一致', lessons: [], scores: [] });
    expect(run.calls).toEqual([{ kind: 'edstem', args: ['auth', 'status', '--json'] }]);
    expect(run.stderr).toContain('设置 us，edstem 登录 au');
  });

  it('links lessons on the explicit region when it matches; auto makes no extra call and links on au', async () => {
    const env = sourceConfigEnv({ ...other, edRegion: 'us' });
    const us = await runCollectorScript('scripts/sources/ed/collect.mjs', ['CS101', 'Fall 2026', '<out>'], {
      edstem: { ...units, 'auth status --json': { authenticated: true, user: { id: 1 }, region: 'us' } },
    }, env);
    expect(us.code, us.stderr).toBe(0);
    expect(JSON.parse(us.output!).lessons[0].url).toBe('https://edstem.org/us/courses/5/lessons/9');
    expect(us.calls[0]).toEqual({ kind: 'edstem', args: ['auth', 'status', '--json'] });
    const auto = await runCollectorScript('scripts/sources/ed/collect.mjs', ['CS101', 'Fall 2026', '<out>'], { edstem: units }, sourceConfigEnv(other));
    expect(auto.code, auto.stderr).toBe(0);
    expect(JSON.parse(auto.output!).lessons[0].url).toBe('https://edstem.org/au/courses/5/lessons/9');
    expect(auto.calls.some(call => (call.args as string[] | undefined)?.[0] === 'auth')).toBe(false);
  });

  it('matches a generic code case-insensitively and as literal text', async () => {
    const lower = await runCollectorScript('scripts/sources/ed/collect.mjs', ['cs101', 'Fall 2026', '<out>'], { edstem: units }, sourceConfigEnv(other));
    expect(JSON.parse(lower.output!)).toMatchObject({ status: 'complete', unitId: '5' });
    // `CS.101` must not match `CSX101` through the regex dot; the only unit starting with the literal text is absent.
    const dotted = await runCollectorScript('scripts/sources/ed/collect.mjs', ['CS.101', 'Fall 2026', '<out>'], { edstem: units }, sourceConfigEnv(other));
    expect(JSON.parse(dotted.output!)).toMatchObject({ status: 'not_found' });
  });

  it('reads scores from the API base of the CLI region and refuses another explicit region', async () => {
    const auth = { authenticated: true, user: { id: 501 }, region: 'eu' };
    const scenario = {
      edstem: { 'auth status --json': auth },
      fetch: {
        'https://eu.edstem.org/api/lessons/3001/attempts/501': { json: { attempts: [{ id: 9, user_id: 501, lesson_id: 3001 }], final_id: null } },
      },
    };
    const run = await runCollectorScript('scripts/sources/ed/scores.mjs', ['3001'], scenario, { EDSTEM_TOKEN: 'synthetic-token', ...sourceConfigEnv(other) });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).results).toEqual([{ lessonId: '3001', status: 'no_final_submission', durationMs: 0 }]);
    const refused = await runCollectorScript('scripts/sources/ed/scores.mjs', ['3001'], scenario, { EDSTEM_TOKEN: 'synthetic-token', ...sourceConfigEnv({ ...other, edRegion: 'us' }) });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Ed 登录区域与设置不一致');
    expect(refused.calls.filter(call => call.kind === 'fetch')).toEqual([]);
  });
});

describe('collect stage over the job\'s sources', () => {
  let project: Project | undefined;
  afterEach(async () => { await project?.cleanup(); project = undefined; });

  it('passes the configuration to every real collector command', async () => {
    const courses = [syntheticCourse(1)];
    project = await createProject(courses);
    const store = await openStore(project.projectDir, () => START);
    const fakes = fakeCollectors(courses);
    const requests: CollectorRequest[] = [];
    const pipeline = pipelineFor(project, store, { runCollector: async request => { requests.push(request); return fakes.runCollector(request); }, callModel: fakeModel(courses).callModel });
    await pipeline.start(['900001']);
    await pipeline.idle();
    expect(requests.map(request => [request.source, request.script])).toEqual([
      ['canvas', 'sources/canvas/collect.mjs'], ['ed', 'sources/ed/collect.mjs'], ['handbook', 'institutions/unimelb/handbook-collect.mjs'],
    ]);
    for (const request of requests) expect(JSON.parse(request.env![SOURCE_CONFIG_ENV]!)).toEqual(DEFAULT_SOURCE_CONFIG);
    expect(store.getJob(pipeline.status().jobId!)!.sources).toEqual(['canvas', 'ed', 'handbook']);
    store.close();
  });

  it('collects, validates and settles with two sources only, and a resume keeps the job\'s list', async () => {
    const courses = [syntheticCourse(1)];
    project = await createProject(courses);
    const store = await openStore(project.projectDir, () => START);
    const fakes = fakeCollectors(courses, { '900001:ed': { exit: [75] } });
    const sources: CourseSource[] = [canvasSource, edSource];
    const deps = { runCollector: fakes.runCollector, callModel: fakeModel(courses).callModel };
    const first = pipelineFor(project, store, deps, { ids: ['run-1', 'run-2'], sources });
    await first.start(['900001']);
    await first.idle();
    expect(store.getJob('run-1')!.sources).toEqual(['canvas', 'ed']);
    expect(store.getStage('run-1', '900001', 'collect')).toMatchObject({ status: 'failed', checkpoint: { sources: { canvas: { exitCode: 0 } } } });
    expect(first.status().courses[0]!.reason).toContain('Ed 暂时无法访问');
    // The fake Ed collector now succeeds; the resume reuses Canvas and runs the job's two sources only.
    const second = pipelineFor(project, store, { runCollector: fakeCollectors(courses).runCollector, callModel: deps.callModel }, { ids: ['run-2'], sources });
    await second.resume('run-1');
    await second.idle();
    const collect = store.getStage('run-2', '900001', 'collect')!;
    expect(Object.keys((collect.checkpoint as { sources: object }).sources)).toEqual(['canvas', 'ed']);
    expect(store.getStage('run-2', '900001', 'validate')!.status).toBe('succeeded');
    const course = second.status().courses[0]!;
    // Without a Handbook the fixture's Handbook references are not collected: the course fails validation, with no
    // Handbook collection reason (the reason for a missing framework source is per-source from PR 3 on).
    expect(course.status).toBe('failed');
    expect(course.reason).not.toContain('Handbook 数据未能读取');
    expect(store.getJob('run-2')!.sources).toEqual(['canvas', 'ed']);
    store.close();
  });

  it('refuses to resume a job whose sources are no longer available', async () => {
    const courses = [syntheticCourse(1)];
    project = await createProject(courses);
    const store = await openStore(project.projectDir, () => START);
    const deps = { runCollector: fakeCollectors(courses, { '900001:canvas': { exit: [75] } }).runCollector, callModel: fakeModel(courses).callModel };
    const first = pipelineFor(project, store, deps, { ids: ['run-1'] });
    await first.start(['900001']);
    await first.idle();
    const narrower = pipelineFor(project, store, deps, { ids: ['run-2'], sources: [canvasSource, edSource] });
    await expect(narrower.resume('run-1')).rejects.toThrow('SOURCES_CHANGED');
    store.close();
  });
});

describe('spawnCollector', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

  it('adds the command\'s environment to the child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studyorbit-spawn-'));
    dirs.push(dir);
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'env.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], process.env.${SOURCE_CONFIG_ENV} ?? 'missing');\n`);
    const out = join(dir, 'env.txt');
    const result = await spawnCollector({ source: 'canvas', script: 'env.mjs', args: [out], env: sourceConfigEnv(DEFAULT_SOURCE_CONFIG), cwd: dir, registerStop: () => () => {}, signal: new AbortController().signal });
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(DEFAULT_SOURCE_CONFIG);
  });
});
