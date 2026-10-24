import { expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { courseSummaries, mergePlanPages, monthGrid, mondayOf, needsYou, orderDayItems, pickTerm, weekModel, zonedIso, type Plan } from '../../web/src/week.js';
import { WeekStore } from '../../web/src/weekStore.js';
const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const settings = { timeZone: 'Australia/Melbourne', weekdayMinutes: [120, 60, 60, 60, 60, 0, 0], teachingWeekAnchor: '2026-07-27', breakWeeks: [] };
const course = { id: 'c1', moduleId: 'm1', code: 'SYNT10001', name: 'Synthetic Studies', term: '2026 S2', assessmentsComplete: true };
const assessment = (id: string, extra: Record<string, unknown> = {}) => ({ id, courseId: 'c1', name: `Assessment ${id}`, isFinal: false, status: 'not_started' as const, ...extra });
const emptyPlan: Plan = { settings, days: [], work: [], overflow: [], unestimated: [], deadlines: [] };
const week = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

it('builds seven Monday-to-Sunday columns with used and available hours', () => {
  expect(mondayOf('2026-10-25')).toBe('2026-10-19');
  const plan: Plan = { ...emptyPlan, days: week.map(date => ({ date, availableMinutes: date === '2026-10-19' ? 120 : 60, items: date === '2026-10-19' ? [{ workId: 'a1', minutes: 90 }] : [] })),
    work: [{ workId: 'a1', title: 'Assessment a1', courseId: 'c1', due: '2026-10-21T12:59:00Z', estimateMinutes: 90, estimateOrigin: 'owner', actualMinutes: 0 }] };
  const model = weekModel({ plan, courses: [course], assessments: [assessment('a1')], tasks: [], monday: '2026-10-19', timeZone: settings.timeZone });
  expect(model.days.map(day => day.date)).toEqual(week);
  expect(model.days[0]).toMatchObject({ availableMinutes: 120, usedMinutes: 90 });
  expect(model.days[1]).toMatchObject({ availableMinutes: 60, usedMinutes: 0 });
});

it('puts a Wednesday 23:59 deadline in the deadline row and its planned minutes on Monday', () => {
  const plan: Plan = { ...emptyPlan, days: [{ date: '2026-10-19', availableMinutes: 120, items: [{ workId: 'a1', minutes: 60 }] }],
    work: [{ workId: 'a1', title: 'Assessment a1', courseId: 'c1', due: '2026-10-21T12:59:00Z', estimateMinutes: 60, estimateOrigin: 'owner', actualMinutes: 0 }],
    deadlines: [{ workId: 't9', title: 'Career fair', due: '2026-10-22T01:00:00Z', date: '2026-10-22', kind: 'all-day' }] };
  const tasks = [{ id: 't9', moduleId: 'm1', title: 'Career fair', source: 'manual' as const, due: '2026-10-22T01:00:00Z', allDay: true, done: false, steps: [{ title: 'Career fair', estimateMinutes: 0, done: false, citations: [] }] }];
  const model = weekModel({ plan, courses: [course], assessments: [assessment('a1', { due: '2026-10-21T12:59:00Z' })], tasks, monday: '2026-10-19', timeZone: settings.timeZone });
  expect(model.days[2]!.deadlines).toEqual([expect.objectContaining({ id: 'a1', kind: 'due', time: '23:59', courseCode: 'SYNT10001' })]);
  expect(model.days[0]!.items).toEqual([expect.objectContaining({ workId: 'a1', minutes: 60, courseCode: 'SYNT10001' })]);
  expect(model.days[3]!.deadlines).toEqual([expect.objectContaining({ id: 't9', kind: 'all-day', manual: true })]);
  expect(model.days[3]!.usedMinutes).toBe(0);
});

it('lists timed items by start time before untimed ones in plan order', () => {
  const items = [{ workId: 'A', minutes: 30 }, { workId: 'B', minutes: 30, startTime: '14:00' }, { workId: 'C', minutes: 30, startTime: '09:30' }, { workId: 'D', minutes: 30 }];
  expect(orderDayItems(items).map(item => item.workId)).toEqual(['C', 'B', 'A', 'D']);
});

it('shows overflow with its missing minutes and unestimated work without guessing an estimate', () => {
  const plan: Plan = { ...emptyPlan, overflow: [{ workId: 'a1', minutes: 90 }], unestimated: [{ workId: 'a2' }],
    work: [{ workId: 'a1', title: 'Assessment a1', courseId: 'c1', due: '2026-10-21T12:59:00Z', estimateMinutes: 300, estimateOrigin: 'agent', actualMinutes: 0 },
      { workId: 'a2', title: 'Assessment a2', courseId: 'c1', due: '2026-10-23T12:59:00Z', actualMinutes: 0 }] };
  const model = weekModel({ plan, courses: [course], assessments: [], tasks: [], monday: '2026-10-19', timeZone: settings.timeZone });
  expect(model.overflow).toEqual([expect.objectContaining({ workId: 'a1', minutes: 90 })]);
  expect(model.unestimated).toEqual([expect.objectContaining({ workId: 'a2', estimateMinutes: undefined })]);
  const needs = needsYou({ attention: [{ site: 'ed', kind: 'blocked' }], overflow: model.overflow, unestimated: model.unestimated });
  expect(needs).toEqual([{ kind: 'blocked', site: 'ed' },
    expect.objectContaining({ kind: 'overflow', workId: 'a1', minutes: 90 }), { kind: 'unestimated', count: 1 }]);
});

it('keeps the sync status items in "needs you" before planning gaps', () => {
  const sync = [{ kind: 'select' as const, count: 3 }, { kind: 'policy' as const, course: 'SYNB20002', courseId: 'c2', value: 'prohibited' as const, quote: 'No AI.' }];
  expect(needsYou({ attention: sync, overflow: [], unestimated: [{ workId: 'a2', title: 'a2', manual: false }] }))
    .toEqual([...sync, { kind: 'unestimated', count: 1 }]);
});

it('summarises courses with graded weight, unknown weights and the next deadline', () => {
  const [summary] = courseSummaries([course], [assessment('a1', { weight: 30, score: 85, due: '2026-09-01T00:00:00Z' }), assessment('a2', { due: '2026-10-30T00:00:00Z' }),
    assessment('a3', { weight: 40, due: '2026-10-25T00:00:00Z' }), assessment('a4', { weight: 30, status: 'submitted', due: '2026-10-24T00:00:00Z' })], new Date('2026-10-23T00:00:00Z'));
  expect(summary).toMatchObject({ id: 'c1', gradedWeight: 30, unknownWeight: true, next: { title: 'Assessment a3', due: '2026-10-25T00:00:00Z' } });
});

it('treats assessments the plan no longer lists as closed in the deadline row and next deadline', () => {
  // The planner drops assessments whose linked platform items are submitted or removed.
  const plan: Plan = { ...emptyPlan, work: [{ workId: 'a2', title: 'Assessment a2', courseId: 'c1', due: '2026-10-26T12:59:00Z', actualMinutes: 0 }] };
  const items = [assessment('a1', { due: '2026-10-21T12:59:00Z' }), assessment('a2', { due: '2026-10-26T12:59:00Z' })];
  const model = weekModel({ plan, courses: [course], assessments: items, tasks: [], monday: '2026-10-19', timeZone: settings.timeZone });
  expect(model.days[2]!.deadlines).toEqual([expect.objectContaining({ id: 'a1', done: true })]);
  expect(courseSummaries([course], items, new Date('2026-10-20T00:00:00Z'), plan)[0]!.next?.title).toBe('Assessment a2');
});

it('shows exam times in the deadline row and keeps undated exams as unknown', () => {
  const plan: Plan = { ...emptyPlan, deadlines: [{ workId: 'e1', title: 'Final exam', courseId: 'c1', due: '2026-10-22T23:00:00Z', date: '2026-10-23', kind: 'exam' },
    { workId: 'e2', title: 'Mid exam', courseId: 'c1', kind: 'exam' }] };
  const items = [assessment('e1', { name: 'Final exam', kind: 'exam', due: '2026-10-22T23:00:00Z' }), assessment('e2', { name: 'Mid exam', kind: 'exam' })];
  const model = weekModel({ plan, courses: [course], assessments: items, tasks: [], monday: '2026-10-19', timeZone: settings.timeZone });
  expect(model.days[4]!.deadlines).toEqual([expect.objectContaining({ id: 'e1', kind: 'exam', time: '10:00', done: false })]);
  expect(courseSummaries([course], items, new Date('2026-10-20T00:00:00Z'), plan)[0]!.undatedExams).toEqual(['Mid exam']);
});

it('shows configured hours on days outside the plan', () => {
  const model = weekModel({ plan: { ...emptyPlan, days: [{ date: '2026-10-23', availableMinutes: 60, items: [] }] }, courses: [course], assessments: [], tasks: [], monday: '2026-10-19', timeZone: settings.timeZone });
  expect(model.days.map(day => day.availableMinutes)).toEqual([120, 60, 60, 60, 60, 0, 0]);
});

it('builds a Monday-first month calendar of deadlines', () => {
  const grid = monthGrid('2026-10-21', new Map([['2026-10-21', [{ id: 'a1', title: 'Assessment a1', kind: 'due' as const, done: false, manual: false }]]]));
  expect(grid[0]![0]).toMatchObject({ date: '2026-09-28', inMonth: false });
  expect(grid.at(-1)!.at(-1)).toMatchObject({ date: '2026-11-01' });
  expect(grid.flat().find(cell => cell.date === '2026-10-21')!.deadlines).toHaveLength(1);
});

it('merges paginated plan pages and resolves text continuations', () => {
  const plan = mergePlanPages([
    { ...emptyPlan, days: [{ date: '2026-10-19', availableMinutes: 120, items: [{ workId: 'a1', minutes: 30 }] }], work: [{ workId: 'a1', title: 'Long ', actualMinutes: 0 }], nextCursor: 'x' },
    { days: [{ date: '2026-10-19', availableMinutes: 120, items: [{ workId: 'a2', minutes: 30 }] }], work: [], overflow: [], unestimated: [], deadlines: [],
      textContinuations: [{ collection: 'work', workId: 'a1', field: 'title', offset: 5, text: 'title' }] },
  ]);
  expect(plan.days).toEqual([{ date: '2026-10-19', availableMinutes: 120, items: [{ workId: 'a1', minutes: 30 }, { workId: 'a2', minutes: 30 }] }]);
  expect(plan.work[0]!.title).toBe('Long title');
  expect(plan.settings).toEqual(settings);
});

it('converts a local date and time into an instant with the zone offset', () => {
  expect(zonedIso('2026-10-21', '23:59', 'Australia/Melbourne')).toBe('2026-10-21T23:59:00+11:00');
  expect(zonedIso('2026-06-01', '09:00', 'Australia/Melbourne')).toBe('2026-06-01T09:00:00+10:00');
  expect(zonedIso('2026-06-01', '09:00', 'UTC')).toBe('2026-06-01T09:00:00+00:00');
  expect(pickTerm([course, { ...course, id: 'c2', term: '2026 S1' }, { ...course, id: 'c3' }])).toBe('2026 S2');
});

function envelope(command: string, data: unknown) { return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: true, data, meta })); }
const list = (items: unknown[], nextCursor?: string) => ({ items, evidence: [], coverage: { complete: true, gaps: [] }, ...(nextCursor ? { nextCursor } : {}) });
it('reads every plan page from today and sends owner writes with the session and plan scope', async () => {
  const secret = 'a'.repeat(64);
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const command = String(url).slice(5); const body = JSON.parse(String(init?.body));
    if (command === 'plan.read') return envelope(command, body.cursor ? { ...emptyPlan, settings: undefined, days: [{ date: '2026-10-20', availableMinutes: 60, items: [{ workId: 'a1', minutes: 60 }] }] }
      : { ...emptyPlan, days: [{ date: '2026-10-19', availableMinutes: 120, items: [] }], work: [{ workId: 'a1', title: 'Assessment a1', courseId: 'c1', estimateMinutes: 60, estimateOrigin: 'owner', actualMinutes: 0 }], nextCursor: 'p2' });
    if (command === 'assessments.list') return envelope(command, body.cursor ? list([assessment('a2')]) : list([assessment('a1')], 'n'));
    return envelope(command, { 'courses.list': list([course]), 'tasks.list': list([]), 'planning.settings.read': { settings },
      'confirmation.list': { items: [] }, 'plan.start.set': { recorded: true } }[command]);
  });
  const store = new WeekStore(createClient(secret, fetcher), () => new Date('2026-10-23T02:00:00Z'));
  await store.refresh();
  const state = store.getSnapshot();
  expect(state.plan?.days.map(day => day.date)).toEqual(['2026-10-19', '2026-10-20']);
  expect(state.assessments).toHaveLength(2);
  expect(state.scope).toMatchObject({ term: '2026 S2', startDate: '2026-10-23' });
  expect(await store.setStart('a1', '2026-10-20', '09:30')).toBe(true);
  const write = fetcher.mock.calls.find(([url]) => url === '/api/plan.start.set')!;
  expect(write[1]!.headers).toMatchObject({ 'X-Coursework-Session': secret });
  expect(JSON.parse(String(write[1]!.body))).toEqual({ ...state.scope, workId: 'a1', date: '2026-10-20', time: '09:30' });
});
