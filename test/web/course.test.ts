import { expect, it } from 'vitest';
import { UNKNOWN_SPAN, arcPath, courseFigures, ringSegments } from '../../web/src/course.js';

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
