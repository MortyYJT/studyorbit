import { describe, expect, it } from 'vitest';
import {
  CANVAS_API_BASE,
  MAX_CAPTURE_BYTES,
  parseCanvasCourses,
  parseCanvasGroups,
  parseCanvasTabs,
} from '../../src/sync/canvas-api.js';

const source = `${CANVAS_API_BASE}/courses/12345/assignment_groups?include[]=assignments&include[]=submission&per_page=100`;
const now = '2026-10-24T00:00:00Z';

const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: 700001,
  name: 'Synthetic Assignment 1',
  course_id: 12345,
  due_at: '2026-10-31T12:59:00Z',
  unlock_at: '2026-10-01T00:00:00Z',
  points_possible: 20,
  assignment_group_id: 501,
  html_url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments/700001',
  updated_at: '2026-10-20T08:00:00Z',
  submission: { workflow_state: 'graded', score: 17.5, grade: 'synthetic-extra' },
  extra_canvas_key: 'SYNTHETIC_CANVAS_MARKER',
  ...overrides,
});

const group = (overrides: Record<string, unknown> = {}) => ({
  id: 501,
  name: 'Synthetic Assignments',
  group_weight: 30,
  extra_canvas_key: 'SYNTHETIC_CANVAS_MARKER',
  assignments: [assignment()],
  ...overrides,
});

const groupsText = (groups: unknown[] = [group()]) => JSON.stringify(groups);

describe('Canvas API capture parsing (layered-sync task 3.1)', () => {
  it('maps groups, assignments and their API values with via api, source and no quote', () => {
    const parsed = parseCanvasGroups(groupsText(), { source, courseId: '12345', now: () => new Date(now) });
    expect(parsed).toMatchObject({ source, via: 'api', coverage: 'api', unweighted: false });
    expect(parsed.groups).toHaveLength(1);
    const first = parsed.groups[0]!;
    expect(first).toMatchObject({ id: '501', name: 'Synthetic Assignments',
      weight: { value: 30, state: 'found', via: 'api', source } });
    const item = first.assignments[0]!;
    expect(item).toMatchObject({
      id: '700001', name: 'Synthetic Assignment 1', courseId: '12345', htmlUrl: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments/700001',
      assignmentGroupId: '501',
      group: { id: '501', name: 'Synthetic Assignments', weight: { value: 30, state: 'found', via: 'api', source } },
      due: { value: '2026-10-31T12:59:00Z', state: 'found', via: 'api', source },
      unlockAt: { value: '2026-10-01T00:00:00Z', state: 'found', via: 'api', source },
      outOf: { value: 20, state: 'found', via: 'api', source },
      score: { value: 17.5, state: 'found', via: 'api', source },
      status: { value: 'graded', state: 'found', via: 'api', source },
      updatedAt: { value: '2026-10-20T08:00:00Z', state: 'found', via: 'api', source },
    });
    for (const field of [item.due, item.unlockAt, item.outOf, item.score, item.status, item.updatedAt]) expect(field).not.toHaveProperty('quote');
    expect(JSON.stringify(parsed)).not.toContain('SYNTHETIC_CANVAS_MARKER');
  });

  it('maps Canvas null to unknown with the check time and no via or source', () => {
    const parsed = parseCanvasGroups(groupsText([group({ assignments: [assignment({ due_at: null, unlock_at: null,
      points_possible: null, updated_at: null, submission: null })] })]), { source, courseId: '12345', now: () => new Date(now) });
    const item = parsed.groups[0]!.assignments[0]!;
    for (const field of [item.due, item.unlockAt, item.outOf, item.score, item.updatedAt]) {
      expect(field).toEqual({ value: null, state: 'unknown', checkedAt: '2026-10-24T00:00:00.000Z' });
    }
    expect(item.status).toMatchObject({ value: 'not_started', state: 'found', via: 'api', source });
  });

  it('maps submission statuses: submitted and pending_review are submitted, unsubmitted is not_started', () => {
    const statuses = ['graded', 'submitted', 'pending_review', 'unsubmitted'];
    const parsed = parseCanvasGroups(groupsText([group({ assignments: statuses.map((workflow_state, index) =>
      assignment({ id: 700010 + index, submission: { workflow_state, score: null } })) })]), { source, courseId: '12345', now: () => new Date(now) });
    expect(parsed.groups[0]!.assignments.map(item => item.status.value)).toEqual(['graded', 'submitted', 'submitted', 'not_started']);
  });

  it('uses only text from the first [ or { and drops unknown keys', () => {
    const parsed = parseCanvasGroups(`while(1);\n${groupsText()}`, { source, courseId: '12345', now: () => new Date(now) });
    expect(parsed.groups).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain('while(1)');
  });

  it('ignores the JSON viewer controls Edge copies after the JSON (live run 2026-10-27)', () => {
    const courses = JSON.stringify([{ id: 12345, name: 'Synthetic Systems', course_code: 'ABCD10001', term: { name: 'Semester 2 2026' } }]);
    for (const trailer of ['\nPretty-print', '\n美观输出', '\n\t[x] Pretty print\n']) {
      expect(parseCanvasCourses(`${courses}${trailer}`).candidates.map(course => course.code)).toEqual(['ABCD10001']);
      expect(parseCanvasGroups(`${groupsText()}${trailer}`, { source, courseId: '12345', now: () => new Date(now) }).groups).toHaveLength(1);
    }
  });

  it('refuses a sign-in page or other non-JSON with a fresh-copy hint and never echoes the page', () => {
    const signIn = '<html><body>SYNTHETIC_SIGN_IN_MARKER sign in</body></html>';
    expect(() => parseCanvasGroups(signIn, { source, courseId: '12345', now: () => new Date(now) }))
      .toThrow(/not the expected JSON/i);
    try { parseCanvasGroups(signIn, { source, courseId: '12345', now: () => new Date(now) }); }
    catch (error) { expect((error as Error).message).toMatch(/copy/i); expect((error as Error).message).not.toContain('SYNTHETIC_SIGN_IN_MARKER'); }
  });

  it('refuses a groups page whose assignments belong to another Canvas course', () => {
    const wrong = groupsText([group({ assignments: [assignment({ course_id: 999 })] })]);
    expect(() => parseCanvasGroups(wrong, { source, courseId: '12345', now: () => new Date(now) }))
      .toThrow(/999.*12345|12345.*999/);
    try { parseCanvasGroups(wrong, { source, courseId: '12345', now: () => new Date(now) }); }
    catch (error) { expect((error as Error).message).toMatch(/nothing was stored/i); expect((error as Error).message).toMatch(/copy/i); }
  });

  it('accepts exactly 100 groups as partial coverage and refuses 101 groups', () => {
    const hundred = Array.from({ length: 100 }, (_, index) => group({ id: 600 + index, name: `Synthetic Group ${index}`, assignments: [] }));
    expect(parseCanvasGroups(groupsText(hundred), { source, courseId: '12345', now: () => new Date(now) })).toMatchObject({ coverage: 'partial' });
    const over = Array.from({ length: 101 }, (_, index) => group({ id: 700 + index, name: `Synthetic Group ${index}`, assignments: [] }));
    expect(() => parseCanvasGroups(groupsText(over), { source, courseId: '12345', now: () => new Date(now) })).toThrow(/at most 100|100 groups/i);
  });

  it('marks a course with only weight-0 groups as unweighted', () => {
    const parsed = parseCanvasGroups(groupsText([group({ group_weight: 0 }), group({ id: 502, name: 'Synthetic Other', group_weight: 0, assignments: [] })]),
      { source, courseId: '12345', now: () => new Date(now) });
    expect(parsed.unweighted).toBe(true);
    expect(parsed.groups.map(entry => entry.weight.value)).toEqual([0, 0]);
  });

  it('refuses clipboard text over 5 MB without echoing it', () => {
    const marker = 'SYNTHETIC_OVERSIZE_MARKER';
    const text = marker + 'x'.repeat(MAX_CAPTURE_BYTES);
    try { parseCanvasGroups(text, { source, courseId: '12345', now: () => new Date(now) }); }
    catch (error) {
      expect((error as Error).message).toMatch(/5 MB|too large/i);
      expect((error as Error).message).not.toContain(marker);
    }
    expect(() => parseCanvasGroups(text, { source, courseId: '12345', now: () => new Date(now) })).toThrow();
  });

  it('maps courses to code, term, name and Canvas page and counts skipped entries', () => {
    const captured = parseCanvasCourses(JSON.stringify([
      { id: 12345, name: 'Synthetic Systems', course_code: 'ABCD10001_2026_SM2', term: { name: 'Semester 2 2026' }, extra: 'dropped' },
      { id: 12346, name: 'Synthetic Winter WXYZ20002', course_code: 'no code here', term: { name: 'Winter 2026' } },
      { id: 12347, name: 'Synthetic Unknown Term EFGH30003', course_code: 'EFGH30003', term: { name: 'Synthetic Term' } },
      { id: 12348, name: 'Synthetic Missing Code', course_code: 'none', term: { name: 'Summer 2026' } },
    ]));
    expect(captured.skipped).toBe(2);
    expect(captured.candidates).toEqual([
      { code: 'ABCD10001', name: 'Synthetic Systems', term: '2026:S2', pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/12345' } },
      { code: 'WXYZ20002', name: 'Synthetic Winter WXYZ20002', term: '2026:WINTER', pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/12346' } },
    ]);
  });

  it('parses all supported term names tolerantly', () => {
    const row = (id: number, term: string) => ({ id, name: `Synthetic ${id}`, course_code: `ABCD${String(id).padStart(5, '0')}`, term: { name: term } });
    const parsed = parseCanvasCourses(JSON.stringify([row(101, 'Semester 1 2027'), row(102, '2027 Semester 2'),
      row(103, 'Summer 2027'), row(104, 'WINTER, 2027'), row(105, '2027 SM2')]));
    expect(parsed.candidates.map(course => course.term)).toEqual(['2027:S1', '2027:S2', '2027:SUMMER', '2027:WINTER', '2027:S2']);
  });

  it('maps tabs with their id, label, type and optional URL', () => {
    const tabsSource = `${CANVAS_API_BASE}/courses/12345/tabs`;
    const parsed = parseCanvasTabs(JSON.stringify([
      { id: 'assignments', label: 'Assignments', type: 'internal', html_url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments', extra: 'dropped' },
      { id: 'home', label: 'Home', type: 'internal' },
    ]), { source: tabsSource });
    expect(parsed).toEqual({ source: tabsSource, via: 'api', tabs: [
      { id: 'assignments', label: 'Assignments', type: 'internal', url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments' },
      { id: 'home', label: 'Home', type: 'internal' },
    ] });
  });
});
