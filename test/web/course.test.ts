import { expect, it } from 'vitest';
import { presets } from '../../src/agent/presets.js';
import { UNKNOWN_SPAN, agentEntries, arcPath, assessmentGroups, isRemainder, policyView, valueLabel, canJudge, courseFigures, displayStatus, levelView, mergePlanWork, minutesFrom, originOf, ownerValue, presetIds, ringSegments, sourceLink } from '../../web/src/course.js';

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

it('shows levels from autonomy.read: exams none, prohibited courses locked at L0, overrides and defaults as read', () => {
  const entry = (assessmentId: string, override: 0 | 1 | 2 | null, effectiveLevel: 0 | 1 | 2 | null, kind: 'quiz' | 'exam' | null = 'quiz') =>
    ({ assessmentId, kind, applicable: kind !== 'exam', requiredLevel: kind === 'exam' ? null : 1 as const, override, effectiveLevel });
  const read = (policy: 'allowed' | 'prohibited' | null, assessments: ReturnType<typeof entry>[]) =>
    ({ courseId: 'c1', policy, policyOrigin: policy ? 'owner' as const : null, cap: policy === 'prohibited' ? 0 as const : 2 as const, defaultLevel: 1 as const, assessments });
  const allowed = read('allowed', [entry('quiz', 2, 2), entry('essay', null, 1), entry('exam', null, null, 'exam')]);
  expect(levelView({ id: 'exam', kind: 'exam' }, allowed)).toEqual({ kind: 'none' });
  expect(agentEntries({ kind: 'exam' }, 'allowed')).toEqual({ complete: false, explain: false });
  expect(levelView({ id: 'quiz', kind: 'quiz' }, allowed)).toEqual({ kind: 'level', level: 2, source: 'override' });
  expect(levelView({ id: 'essay' }, allowed)).toEqual({ kind: 'level', level: 1, source: 'default' });
  expect(levelView({ id: 'quiz', kind: 'quiz' }, read('prohibited', [entry('quiz', 2, 0)]))).toEqual({ kind: 'locked' });
  expect(agentEntries({ kind: 'quiz' }, 'prohibited')).toEqual({ complete: false, explain: true });
  // Not yet read or missing from the read: unknown, never a guessed level.
  expect(levelView({ id: 'quiz', kind: 'quiz' }, undefined)).toEqual({ kind: 'unknown' });
  expect(levelView({ id: 'other' }, allowed)).toEqual({ kind: 'unknown' });
});

it('maps origins and shows the platform submission when the stored status lags behind', () => {
  const field = (origin: 'owner' | 'agent' | 'sync' | null, value: unknown) => ({ value, origin, citations: [], verdicts: [] }) as never;
  expect(originOf(field('sync', 5))).toBe('platform');
  expect(originOf(field(null, null))).toBeUndefined();
  expect(displayStatus({ status: 'in_progress', platform: { linked: true, submitted: true, removed: false } })).toBe('submitted');
  expect(displayStatus({ status: 'graded', platform: { linked: true, submitted: true, removed: false } })).toBe('graded');
  expect(displayStatus({ status: 'not_started' })).toBe('not_started');
});

it('offers confirm and "use my value" only for an agent value that has no owner verdict yet', () => {
  const agent = { value: 5, origin: 'agent' as const, annotationId: 'ann-1', citations: [], verdicts: [] };
  expect(canJudge(agent)).toBe(true);
  expect(canJudge({ ...agent, verdicts: [{ annotationId: 'ann-1', verdict: 'correct' as const, at: '2026-10-01T00:00:00Z' }] })).toBe(false);
  expect(canJudge({ ...agent, origin: 'owner' as const })).toBe(false);
  expect(canJudge({ ...agent, annotationId: undefined })).toBe(false);
});

it('links only to https Canvas and Ed pages', () => {
  expect(sourceLink('https://canvas.lms.unimelb.edu.au/courses/1/pages/a')).toBe('https://canvas.lms.unimelb.edu.au/courses/1/pages/a');
  expect(sourceLink('https://edstem.org/au/courses/1/lessons')).toBe('https://edstem.org/au/courses/1/lessons');
  expect(sourceLink('http://canvas.lms.unimelb.edu.au/courses/1')).toBeUndefined();
  expect(sourceLink('https://evil.example/canvas.lms.unimelb.edu.au')).toBeUndefined();
  expect(sourceLink('javascript:alert(1)')).toBeUndefined();
  expect(sourceLink('not a url')).toBeUndefined();
  expect(sourceLink(undefined)).toBeUndefined();
});

it('parses owner values per field and rejects invalid input instead of defaulting', () => {
  expect(ownerValue('weight', '25')).toBe(25);
  expect(() => ownerValue('weight', '120')).toThrow();
  expect(() => ownerValue('weight', ' ')).toThrow();
  expect(ownerValue('kind', 'quiz')).toBe('quiz');
  expect(() => ownerValue('kind', 'essay')).toThrow();
  expect(ownerValue('isFinal', 'true')).toBe(true);
  // The wall-clock time is read in the planning time zone, not the browser's.
  expect(ownerValue('due', '2026-10-25T23:59', 'Asia/Tokyo')).toBe('2026-10-25T23:59:00+09:00');
  expect(ownerValue('due', '2026-10-25T23:59', 'Australia/Melbourne')).toBe('2026-10-25T23:59:00+11:00');
  expect(() => ownerValue('due', '2026-10-25', 'Asia/Tokyo')).toThrow();
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

const written = { key: 'syna10001-written', name: 'Written assignments', weight: 15, count: 4 };
const derived = { weight: { state: 'derived' as const } };
const graded = (id: string, score: number) => ({ ...item(id, 3.75, score), group: written, readState: { ...derived, status: { state: 'found' as const } } });
it('groups assessments by component with weight and the earned share computed by code (scenario "Component group")', () => {
  const remainder = { ...item('rest', 7.5), group: { ...written, role: 'remainder' as const }, readState: { weight: { state: 'derived' as const } } };
  const exam = { ...item('exam', 50, undefined, true), group: { key: 'syna10001-exam', name: 'Final exam', weight: 50 },
    readState: { isFinal: { state: 'found' as const }, weight: { state: 'found' as const } } };
  const groups = assessmentGroups([graded('a1', 80), item('loose', 10, 50), exam, graded('a2', 100), remainder]);
  expect(groups.map(group => [group.key, group.name, group.weight, group.items.map(row => row.id)])).toEqual([
    ['syna10001-written', 'Written assignments', 15, ['a1', 'a2', 'rest']], ['syna10001-exam', 'Final exam', 50, ['exam']], [undefined, undefined, undefined, ['loose']]]);
  expect(groups[0]!.earned).toBeCloseTo(6.75);
  expect(groups[1]!.earned).toBe(0);
  expect(isRemainder(remainder)).toBe(true);
  expect([graded('a1', 80), exam, item('loose', 10)].map(isRemainder)).toEqual([false, false, false]);
  // The role, not the shape of the read state, marks a remainder.
  expect(isRemainder({ ...remainder, group: { ...written, role: 'item' as const } })).toBe(false);
  expect(valueLabel(graded('a1', 80), 'weight')).toEqual({ kind: 'derived' });
});
it('leaves a group\'s earned share unknown when a scored item has no weight, like the ring', () => {
  const [group] = assessmentGroups([graded('a1', 80), { ...item('a2', undefined, 90), group: written }]);
  expect(group!.earned).toBeUndefined();
  // An unscored item of unknown weight does not hide what is already earned.
  expect(assessmentGroups([graded('a1', 80), { ...item('a3', undefined), group: written }])[0]!.earned).toBeCloseTo(3);
});
it('takes a final or hurdled component row\'s header weight from the row\'s effective weight', () => {
  const component = { ...item('exam', 40, undefined, true), group: { key: 'syna10001-exam', name: 'Final exam', weight: 50, role: 'component' as const } };
  expect(assessmentGroups([component])[0]!.weight).toBe(40);
  expect(assessmentGroups([{ ...component, weight: undefined }])[0]!.weight).toBeUndefined();
});
it('shows "—" for a not-applicable due date and for rows that carry no read state', () => {
  expect(valueLabel({ ...item('exam', 50), readState: { due: { state: 'not_applicable' as const } } }, 'due')).toEqual({ kind: 'none' });
  expect(valueLabel(item('old', 10), 'due')).toEqual({ kind: 'none' });
  expect(valueLabel({ ...item('old', 10), readState: { weight: { state: 'found' as const } } }, 'due')).toEqual({ kind: 'none' });
});
it('labels derived weights as an even split and unknown fields with their check time (scenario "Derived and unknown labels")', () => {
  const unknownDue = { ...item('late', 10), readState: { due: { state: 'unknown' as const, checkedAt: '2026-10-24T03:00:00Z' }, weight: { state: 'found' as const } } };
  expect(valueLabel(unknownDue, 'due')).toEqual({ kind: 'unknown', checkedAt: '2026-10-24T03:00:00Z' });
  expect(valueLabel(unknownDue, 'weight')).toEqual({ kind: 'value' });
  expect(valueLabel(item('plain', undefined), 'weight')).toEqual({ kind: 'unknown' });
  // An owner or agent value replaces the even split, so it is no longer labelled derived.
  const owned = { ...graded('a1', 80), weight: 4, fields: { weight: { value: 4, origin: 'owner' as const, citations: [], verdicts: [] } } };
  expect(valueLabel(owned, 'weight')).toEqual({ kind: 'value' });
});
it('shows the agent-read AI policy with its quote and the effective origin', () => {
  const read = { ...course, aiPolicy: 'prohibited' as const, readState: { aiPolicy: { state: 'found' as const, quote: 'No AI.' } } };
  expect(policyView(read, { policy: 'prohibited', policyOrigin: 'agent' })).toEqual({ effective: 'prohibited', origin: 'agent', read: 'prohibited', quote: 'No AI.' });
  expect(policyView(read, { policy: 'allowed', policyOrigin: 'owner' })).toEqual({ effective: 'allowed', origin: 'owner', read: 'prohibited', quote: 'No AI.' });
  expect(policyView(course, undefined)).toEqual({});
});

it('uses the registered preset ids', () => {
  expect(Object.values(presetIds).every(id => presets.some(preset => preset.id === id))).toBe(true);
});
