import { expect, it } from 'vitest';
import { presets } from '../../src/agent/presets.js';
import { UNKNOWN_SPAN, agentEntries, arcPath, courseFigures, levelView, mergePlanWork, minutesFrom, originOf, ownerValue, presetIds, recordedPolicy, ringSegments } from '../../web/src/course.js';

const course = { id: 'c1', moduleId: 'm1', code: 'SYNA10001', name: 'Synthetic', term: '2026-S2', assessmentsComplete: false };
const item = (id: string, weight: number | undefined, score?: number, isFinal = false) =>
  ({ id, courseId: 'c1', name: id, isFinal, status: score === undefined ? 'not_started' as const : 'graded' as const,
    ...(weight === undefined ? {} : { weight }), ...(score === undefined ? {} : { score }) });

it('sizes one segment per assessment by weight with earned, lost and ungraded styles and the earned centre total', () => {
  const items = [item('quiz', 10, 80), item('assignment', 50), item('exam', 40, undefined, true)];
  const segments = ringSegments(items);
  expect(segments).toEqual([
    { assessmentId: 'quiz', style: 'earned', start: 0, end: 28.8 },
    { assessmentId: 'quiz', style: 'lost', start: 28.8, end: 36 },
    { assessmentId: 'assignment', style: 'ungraded', start: 36, end: 216 },
    { assessmentId: 'exam', style: 'ungraded', start: 216, end: 360 },
  ].map(segment => ({ ...segment, start: expect.closeTo(segment.start, 6), end: expect.closeTo(segment.end, 6) })));
  expect(courseFigures(course, items, 'H1')).toMatchObject({ earned: 8, gradedWeight: 10, currentAverage: 80 });
  // Known weights below 100 leave the rest of the circle empty instead of stretching the segments.
  expect(ringSegments([item('only', 25, 100)]).at(-1)?.end).toBeCloseTo(90);
  expect(arcPath(70, 0, 90)).toBe('M85.00 15.00 A70 70 0 0 1 155.00 85.00');
});

it('gives unknown weights a fixed unknown-style segment and marks the final figure unavailable because weights are unknown', () => {
  const items = [item('quiz', 20, 50), item('mystery', undefined), item('exam', 80, undefined, true)];
  const segments = ringSegments(items);
  expect(segments.find(segment => segment.assessmentId === 'mystery')).toMatchObject({ style: 'unknown' });
  const mystery = segments.find(segment => segment.assessmentId === 'mystery')!;
  expect(mystery.end - mystery.start).toBeCloseTo(UNKNOWN_SPAN);
  expect(segments.at(-1)?.end).toBeCloseTo(360);
  expect(courseFigures(course, items, 'P').need).toEqual({ status: 'unavailable', reason: 'weights_unknown' });
});

it('shows exams without a level or agent entry, locks prohibited courses at L0 and caps overrides only by policy', () => {
  const known = { overrides: { quiz: 1 as const, essay: null } };
  const quiz = { id: 'quiz', kind: 'quiz' as const };
  expect(levelView({ id: 'exam', kind: 'exam' }, 'allowed', known)).toEqual({ kind: 'none' });
  expect(agentEntries({ kind: 'exam' }, 'allowed')).toEqual({ complete: false, explain: false });
  expect(levelView(quiz, 'prohibited', known)).toEqual({ kind: 'locked' });
  expect(agentEntries({ kind: 'quiz' }, 'prohibited')).toEqual({ complete: false, explain: true });
  expect(levelView(quiz, undefined, known)).toEqual({ kind: 'level', level: 1, source: 'override' });
  // A cleared override follows the default only when the default is known; nothing is guessed otherwise.
  expect(levelView({ id: 'essay' }, 'allowed', known)).toEqual({ kind: 'unknown' });
  expect(levelView({ id: 'essay' }, 'allowed', { ...known, defaultLevel: 2 })).toEqual({ kind: 'level', level: 2, source: 'default' });
  expect(levelView({ id: 'other' }, 'allowed', { ...known, defaultLevel: 2 })).toEqual({ kind: 'unknown' });
});

it('reads the recorded policy only from owner values, keeping agent policy text a suggestion', () => {
  const field = (origin: 'owner' | 'agent' | 'sync' | null, value: unknown) => ({ value, origin, citations: [], verdicts: [] }) as never;
  expect(recordedPolicy(field('owner', 'prohibited'))).toBe('prohibited');
  expect(recordedPolicy(field('agent', 'prohibited'))).toBeUndefined();
  expect(recordedPolicy(field('owner', null))).toBeUndefined();
  expect(originOf(field('sync', 5))).toBe('platform');
  expect(originOf(field(null, null))).toBeUndefined();
});

it('parses owner values per field and rejects invalid input instead of defaulting', () => {
  expect(ownerValue('weight', '25')).toBe(25);
  expect(() => ownerValue('weight', '120')).toThrow();
  expect(() => ownerValue('weight', ' ')).toThrow();
  expect(ownerValue('kind', 'quiz')).toBe('quiz');
  expect(() => ownerValue('kind', 'essay')).toThrow();
  expect(ownerValue('isFinal', 'true')).toBe(true);
  expect(ownerValue('due', '2026-10-25T23:59')).toBe(new Date('2026-10-25T23:59').toISOString());
  expect(minutesFrom('90')).toBe(90);
  expect(() => minutesFrom('1.5')).toThrow();
});

it('merges paged plan work and applies text continuations at their offsets', () => {
  const work = (workId: string, reason?: string) => ({ workId, title: workId, actualMinutes: 0, ...(reason ? { agentEstimate: { minutes: 60, reason } } : {}) });
  const merged = mergePlanWork([
    { days: [], work: [work('a', 'Long')], overflow: [], unestimated: [], deadlines: [], nextCursor: 'next' },
    { days: [], work: [work('b')], overflow: [], unestimated: [], deadlines: [],
      textContinuations: [{ collection: 'work', workId: 'a', field: 'agentEstimate.reason', offset: 4, text: ' reason' }] },
  ]);
  expect(merged.map(item => item.workId)).toEqual(['a', 'b']);
  expect(merged[0]!.agentEstimate?.reason).toBe('Long reason');
});

it('uses the registered preset ids', () => {
  expect(Object.values(presetIds).every(id => presets.some(preset => preset.id === id))).toBe(true);
});
