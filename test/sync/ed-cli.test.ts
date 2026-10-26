import { afterEach, describe, expect, it } from 'vitest';
import type { CourseSelection } from '../../src/domain/schemas.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { edAvailable, edHook, edItems, matchUnit, readEdCourse, type EdCommandResult, type EdRunner } from '../../src/sync/ed-cli.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const key = 'SYNA10001:2026:S2';
const code = 'SYNA10001';
const term = '2026:S2';
const edPage = 'https://edstem.org/au/courses/800001';
const dueAt = '2026-03-01T23:59:00+11:00';

/** Synthetic Ed values: invented codes, ids, titles and files. */
const unit = (overrides: Record<string, unknown> = {}) => ({
  id: 4101, code: 'SYNA10001 S2 2026', name: 'Synthetic Systems', year: '2026', session: 'Semester 2',
  status: 'current', role: 'student', ...overrides,
});
const lesson = (overrides: Record<string, unknown> = {}) => ({
  id: 7001, courseId: 8001, moduleId: 11, title: 'Synthetic lesson one', moduleName: 'Synthetic module',
  type: 'lesson', kind: 'lesson', state: 'published', status: 'open', slideCount: 2, openable: true,
  openableWithoutAttempt: true, dueAt, ...overrides,
});
const undated = lesson({ id: 7002, title: 'Synthetic lesson two', dueAt: null });
const files = [
  { filename: 'synthetic-notes.pdf', lessonId: 7001, slideId: 9001, slideIndex: 0, slideTitle: 'Synthetic slide', source: 'synthetic', url: 'https://edstem.org/au/synthetic' },
  { filename: 'synthetic-slides.pdf', lessonId: 7001, slideId: 9002, slideIndex: 1, slideTitle: 'Synthetic slide two', source: 'synthetic', url: 'https://edstem.org/au/synthetic' },
];

type Reply = EdCommandResult | Error;
function fakeRunner(reply: (args: string[]) => Reply) {
  const calls: string[][] = [];
  const runner: EdRunner = async args => {
    calls.push(args);
    const value = reply(args);
    if (value instanceof Error) throw value;
    return value;
  };
  return { runner, calls };
}
const ok = (stdout: string): EdCommandResult => ({ code: 0, stdout });

/** A complete successful CLI for available/auth/units/lessons/files. */
function workingRunner(options: { auth?: unknown; units?: unknown; lessons?: unknown; files?: unknown; getCode?: number } = {}) {
  return fakeRunner(args => {
    if (args[0] === '--version') return ok('0.8.2\n');
    if (args[0] === 'auth') return ok(JSON.stringify(options.auth ?? { authenticated: true, region: 'au' }));
    if (args[0] === 'units') return ok(JSON.stringify(options.units ?? [unit()]));
    if (args[0] === 'lessons') return ok(JSON.stringify(options.lessons ?? [lesson(), undated]));
    if (args[0] === 'files' && args[1] === 'list') return ok(JSON.stringify(options.files ?? files.filter(file => String(file.lessonId) === args[2])));
    if (args[0] === 'files' && args[1] === 'get') return { code: options.getCode ?? 0, stdout: '' };
    return { code: 1, stdout: '' };
  });
}

function expectReadOnly(calls: readonly string[][]): void {
  for (const args of calls) {
    expect(args).not.toContain('--yes');
    expect(args).not.toContain('mark-read');
    expect(args).not.toContain('submit');
    expect(args[0]).not.toBe('replies');
    expect(args[0]).not.toBe('slides');
    expect(args[0]).not.toBe('update');
    // `lessons list` and `auth status` are reads; their mutating subcommands are never invoked.
    if (args[0] === 'lessons') expect(args[1]).toBe('list');
    if (args[0] === 'auth') expect(args[1]).toBe('status');
    if (args[0] === 'files') expect(['list', 'get']).toContain(args[1]);
  }
}

describe('edstem CLI reader (layered-sync task 7.2)', () => {
  it('available only when the version command succeeds and auth status says authenticated: true; any error is unavailable', async () => {
    expect(await edAvailable(workingRunner().runner)).toBe(true);

    const cases: [string, EdRunner][] = [
      ['missing command', fakeRunner(() => new Error('ENOENT edstem')).runner],
      ['version exits non-zero', fakeRunner(args => args[0] === '--version' ? { code: 127, stdout: '' } : ok('{"authenticated":true}')).runner],
      ['auth exits non-zero', fakeRunner(args => args[0] === '--version' ? ok('0.8.2') : { code: 1, stdout: '{"authenticated":true}' }).runner],
      ['auth says false', workingRunner({ auth: { authenticated: false, region: 'au' } }).runner],
      ['auth is not JSON', fakeRunner(args => args[0] === '--version' ? ok('0.8.2') : ok('signed in maybe')).runner],
    ];
    for (const [, runner] of cases) {
      await expect(edAvailable(runner)).resolves.toBe(false);
    }
  });

  it('matches one unit by code and term; wrong term, two candidates or a substring of another code does not match', () => {
    const course = { code, term };
    expect(matchUnit([unit()], course)).toMatchObject({ id: 4101 });
    expect(matchUnit([unit({ code: 'syna10001 S2 2026' })], course)).toMatchObject({ id: 4101 });
    expect(matchUnit([unit({ year: '2025' })], course)).toBeUndefined();
    expect(matchUnit([unit({ session: 'Semester 1' })], course)).toBeUndefined();
    expect(matchUnit([unit(), unit({ id: 4102 })], course)).toBeUndefined();
    expect(matchUnit([unit({ code: 'SYNA100011 S2 2026' })], course)).toBeUndefined();
    expect(matchUnit([unit({ code: 'SYNB20002 S2 2026' })], course)).toBeUndefined();
    expect(matchUnit([unit({ code: 'SYNA10001 S2 2026' }), unit({ id: 4103, code: 'SYNB20002 S2 2026' })], course)).toMatchObject({ id: 4101 });
  });

  it('matches summer and winter sessions by name', () => {
    expect(matchUnit([unit({ session: 'Summer Semester', code: 'SYNA10001 Summer 2026' })], { code, term: '2026:SUMMER' })).toMatchObject({ id: 4101 });
    expect(matchUnit([unit({ session: 'Winter Semester', code: 'SYNA10001 Winter 2026' })], { code, term: '2026:WINTER' })).toMatchObject({ id: 4101 });
    expect(matchUnit([unit({ session: 'Semester 2' })], { code, term: '2026:SUMMER' })).toBeUndefined();
  });

  it('a summer or winter session with a number is not a semester', () => {
    const s1 = { code, term: '2026:S1' };
    expect(matchUnit([unit({ session: 'Summer Term 1' })], s1)).toBeUndefined();
    expect(matchUnit([unit({ session: 'Semester 1' }), unit({ id: 4102, session: 'Summer Term 1' })], s1)).toMatchObject({ id: 4101 });
    expect(matchUnit([unit({ session: 'Winter Term 2' })], { code, term })).toBeUndefined();
  });

  it('a lesson without a dueAt key is undated, not malformed', async () => {
    const { dueAt: _omitted, ...keyless } = undated;
    const { runner } = workingRunner({ lessons: [lesson(), keyless] });
    const stage = await readEdCourse(runner, { code, term });
    expect(stage?.lessons.map(item => item.dueAt)).toEqual([dueAt, null]);
  });

  it('reads the matched unit lessons and files, keeps dueAt (null for undated) and builds the Ed lesson URL', async () => {
    const { runner, calls } = workingRunner();
    const stage = await readEdCourse(runner, { code, term });

    expect(stage).toMatchObject({ via: 'api', source: 'edstem-cli', unitId: 4101 });
    expect(stage?.lessons).toEqual([
      { id: '7001', title: 'Synthetic lesson one', module: 'Synthetic module', dueAt, url: 'https://edstem.org/au/courses/8001/lessons/7001' },
      { id: '7002', title: 'Synthetic lesson two', module: 'Synthetic module', dueAt: null, url: 'https://edstem.org/au/courses/8001/lessons/7002' },
    ]);
    expect(stage?.files).toEqual([
      { lessonId: '7001', filename: 'synthetic-notes.pdf' },
      { lessonId: '7001', filename: 'synthetic-slides.pdf' },
    ]);
    expect(calls).toContainEqual(['units', 'list', '--json']);
    expect(calls).toContainEqual(['lessons', 'list', '4101', '--json', '--module', 'all', '--state', 'all', '--status', 'all']);
    expect(calls).toContainEqual(['files', 'list', '7001', '--json']);
    expect(calls).toContainEqual(['files', 'list', '7002', '--json']);
    expectReadOnly(calls);
  });

  it('downloads only lessons with files when dest is given and returns the downloaded names', async () => {
    const { runner, calls } = workingRunner();
    const stage = await readEdCourse(runner, { code, term }, { dest: '/synthetic/downloads' });

    expect(calls).toContainEqual(['files', 'get', '7001', '--dest', '/synthetic/downloads']);
    expect(calls).not.toContainEqual(['files', 'get', '7002', '--dest', '/synthetic/downloads']);
    expect(stage?.files).toEqual([
      { lessonId: '7001', filename: 'synthetic-notes.pdf' },
      { lessonId: '7001', filename: 'synthetic-slides.pdf' },
    ]);
    expectReadOnly(calls);
  });

  it('treats malformed output, a failed download or an unmatched unit as unavailable for this course', async () => {
    const malformed = fakeRunner(args => {
      if (args[0] === 'units') return ok(JSON.stringify([unit()]));
      if (args[0] === 'lessons') return ok('not the lessons JSON');
      if (args[0] === 'files' && args[1] === 'list') return ok('[]');
      return { code: 1, stdout: '' };
    });
    await expect(readEdCourse(malformed.runner, { code, term })).resolves.toBeUndefined();

    const failedDownload = workingRunner({ getCode: 1 });
    await expect(readEdCourse(failedDownload.runner, { code, term }, { dest: '/synthetic/downloads' })).resolves.toBeUndefined();

    const wrongTerm = workingRunner({ units: [unit({ year: '2025' })] });
    await expect(readEdCourse(wrongTerm.runner, { code, term })).resolves.toBeUndefined();
  });

  it('the hook stores the CLI stage through recordStage when available, and stores nothing when unavailable', async () => {
    const store = new SqliteRepository(':memory:');
    cleanups.push(() => store.close());
    const jobs = new SyncJobs(store);
    const active = jobs.open([key]);
    const course = { key, code, term, pages: { ed: edPage }, offeredAt: '2026-10-24T00:00:00Z', selected: true } satisfies CourseSelection;
    const ctx = { jobId: active.id, courseKey: key, course, stages: {} };

    const working = workingRunner();
    await edHook(working.runner, jobs)(key, ctx);
    expect(jobs.load(active.id)?.stages?.[key]?.ed).toMatchObject({ via: 'api', source: 'edstem-cli', unitId: 4101 });

    const missing = fakeRunner(() => new Error('ENOENT edstem'));
    store.saveSyncJob({ ...jobs.load(active.id)!, endedAt: new Date().toISOString() });
    const second = jobs.open([key]);
    await edHook(missing.runner, jobs)(key, { ...ctx, jobId: second.id });
    expect(jobs.load(second.id)?.stages?.[key]?.ed).toBeUndefined();
    expect(missing.calls.every(args => args[0] === '--version')).toBe(true);
  });

  it('maps only dated lessons to course-document Ed items with via: "api" and the lesson URL as source', () => {
    const stage = {
      via: 'api' as const, source: 'edstem-cli' as const, unitId: 4101,
      lessons: [
        { id: '7001', title: 'Synthetic lesson one', module: 'Synthetic module', dueAt, url: 'https://edstem.org/au/courses/8001/lessons/7001' },
        { id: '7002', title: 'Synthetic lesson two', module: 'Synthetic module', dueAt: null, url: 'https://edstem.org/au/courses/8001/lessons/7002' },
      ],
      files: [],
    };
    const items = edItems(stage, code);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'SYNA10001:ed:lesson:7001',
      url: 'https://edstem.org/au/courses/8001/lessons/7001',
      name: { value: 'Synthetic lesson one', state: 'found', via: 'api' },
      due: { value: dueAt, state: 'found', via: 'api', source: 'https://edstem.org/au/courses/8001/lessons/7001' },
      kind: { value: null, state: 'unknown' },
    });
  });
});
