import { describe, expect, it } from 'vitest';
import { CourseChangeSchema, courseDismissAt, diffSnapshots, unseenChanges, type CourseChange } from '../shared/course-changes.js';
import type { CourseDocumentV1, CourseDocumentV2 } from '../shared/course-data.js';

// Scenarios from openspec/changes/local-corrections-merge/specs/course-change-log/spec.md. Synthetic data only.
type V1Item = CourseDocumentV1['assessments'][number];
const item = (id: string, patch: Partial<V1Item> = {}): V1Item => ({
  id, name: `Synthetic ${id}`, kind: 'assignment', nature: 'regular', parentId: null, weight: 20, score: null, maxScore: null,
  due: '2026-11-03T12:59:00Z', status: 'not_started', scoring: 'none', rule: null, sources: [], ...patch,
});
const v2Item = (id: string, patch: Partial<V1Item> = {}): CourseDocumentV2['assessments'][number] => ({ ...item(id, patch), refs: [], weightQuote: null, ruleQuote: null, unsourced: [] });
const course = { id: '100', code: 'SYNT10001', name: 'Synthetic Course', term: null };
const v1 = (assessments: V1Item[]): CourseDocumentV1 => ({ version: 1, course, assessments, materials: [] });
const v2 = (assessments: CourseDocumentV2['assessments'], legacyIds: Record<string, string> = {}): CourseDocumentV2 => ({ version: 2, course, assessments, materials: [], legacyIds });

describe('diffSnapshots', () => {
  it('reports a moved due date', () => {
    expect(diffSnapshots(v2([v2Item('canvas:5551')]), v2([v2Item('canvas:5551', { due: '2026-11-10T12:59:00Z' })]))).toEqual([
      { assessmentId: 'canvas:5551', name: 'Synthetic canvas:5551', field: 'due', before: '2026-11-03T12:59:00Z', after: '2026-11-10T12:59:00Z' },
    ]);
  });

  it('treats the same instant in another notation as unchanged', () => {
    expect(diffSnapshots(v2([v2Item('canvas:5551', { due: '2026-11-10T12:59:00Z' })]), v2([v2Item('canvas:5551', { due: '2026-11-10T23:59:00+11:00' })]))).toEqual([]);
  });

  it('reports a changed weight, compared to two decimal places', () => {
    expect(diffSnapshots(v1([item('a1', { weight: 20 })]), v1([item('a1', { weight: 25 })]))).toEqual([
      { assessmentId: 'a1', name: 'Synthetic a1', field: 'weight', before: 20, after: 25 },
    ]);
    expect(diffSnapshots(v1([item('a1', { weight: 20 })]), v1([item('a1', { weight: 20.001 })]))).toEqual([]);
  });

  it('reports a weight cleared to null and set from null, and a due set or cleared', () => {
    expect(diffSnapshots(v1([item('a1', { weight: 20 })]), v1([item('a1', { weight: null })]))).toEqual([
      { assessmentId: 'a1', name: 'Synthetic a1', field: 'weight', before: 20, after: null },
    ]);
    expect(diffSnapshots(v1([item('a1', { weight: null, due: null })]), v1([item('a1', { weight: 15, due: '2026-11-03T12:59:00Z' })]))).toEqual([
      { assessmentId: 'a1', name: 'Synthetic a1', field: 'due', before: null, after: '2026-11-03T12:59:00Z' },
      { assessmentId: 'a1', name: 'Synthetic a1', field: 'weight', before: null, after: 15 },
    ]);
  });

  it('reports both fields of one assessment, due first, with the current name', () => {
    const previous = v1([item('a1', { name: 'Old name' })]);
    const current = v1([item('a1', { name: 'New name', due: '2026-11-04T12:59:00Z', weight: 30 })]);
    expect(diffSnapshots(previous, current)).toEqual([
      { assessmentId: 'a1', name: 'New name', field: 'due', before: '2026-11-03T12:59:00Z', after: '2026-11-04T12:59:00Z' },
      { assessmentId: 'a1', name: 'New name', field: 'weight', before: 20, after: 30 },
    ]);
  });

  it('reports nothing when the documents agree', () => {
    const doc = v1([item('a1'), item('a2', { due: null, weight: null })]);
    expect(diffSnapshots(doc, structuredClone(doc))).toEqual([]);
  });

  it('pairs a v1 assessment with its v2 successor through legacyIds', () => {
    const previous = v1([item('a1', { weight: 20 })]);
    const current = v2([v2Item('canvas:5551', { weight: 25 })], { a1: 'canvas:5551' });
    expect(diffSnapshots(previous, current)).toEqual([
      { assessmentId: 'canvas:5551', name: 'Synthetic canvas:5551', field: 'weight', before: 20, after: 25 },
    ]);
  });

  it('ignores a legacy entry whose target is not in the current document, and pairs a current assessment once', () => {
    const previous = v1([item('a1', { weight: 10 }), item('canvas:5551', { weight: 20 })]);
    // `a1` points at an assessment the same-ID pair already holds; `a2` points at nothing.
    const current = v2([v2Item('canvas:5551', { weight: 20 })], { a1: 'canvas:5551', a2: 'canvas:9999' });
    expect(diffSnapshots(previous, current)).toEqual([]);
  });

  it('never reports score, maximum score, status, name or other field changes', () => {
    const previous = v1([item('a1', { score: null, maxScore: 10, status: 'not_started', name: 'A', kind: 'quiz', rule: null })]);
    const current = v1([item('a1', { score: 9, maxScore: 12, status: 'graded', name: 'B', kind: 'assignment', rule: 'Best 3 of 4' })]);
    const changes = diffSnapshots(previous, current);
    expect(changes).toEqual([]);
    expect(JSON.stringify(diffSnapshots(previous, v1([{ ...current.assessments[0]!, weight: 30 }])))).not.toMatch(/score|maxScore|status/);
  });

  it('ignores added and removed assessments', () => {
    const previous = v2([v2Item('canvas:5551'), v2Item('canvas:5552')]);
    const current = v2([v2Item('canvas:5551'), v2Item('canvas:5560', { weight: 50 })]);
    expect(diffSnapshots(previous, current)).toEqual([]);
  });

  it('orders changes by current document order', () => {
    const previous = v1([item('a1'), item('a2'), item('a3')]);
    const current = v1([item('a3', { weight: 5 }), item('a1', { due: '2026-12-01T00:00:00Z' }), item('a2')]);
    expect(diffSnapshots(previous, current).map(change => `${change.assessmentId}:${change.field}`)).toEqual(['a3:weight', 'a1:due']);
  });

  it('does not modify its inputs', () => {
    const previous = v1([item('a1')]), current = v2([v2Item('canvas:5551', { weight: 30 })], { a1: 'canvas:5551' });
    const before = structuredClone([previous, current]);
    diffSnapshots(previous, current);
    expect([previous, current]).toEqual(before);
  });
});

// Loosely typed so malformed lines can be built too.
const change = (patch: Record<string, unknown> = {}): CourseChange => ({
  at: '2026-10-30T01:00:00.000Z', runId: 'run-1', courseId: '100', assessmentId: 'a1', name: 'Assignment 1', field: 'weight', before: 20, after: 25, ...patch,
}) as CourseChange;

describe('CourseChangeSchema', () => {
  it('accepts a log line and rejects malformed ones', () => {
    expect(CourseChangeSchema.safeParse(change()).success).toBe(true);
    expect(CourseChangeSchema.safeParse(change({ field: 'due', before: '2026-11-03T12:59:00Z', after: null })).success).toBe(true);
    expect(CourseChangeSchema.safeParse(change({ field: 'due', before: 20 })).success).toBe(false);
    expect(CourseChangeSchema.safeParse(change({ field: 'weight', after: '25' })).success).toBe(false);
    expect(CourseChangeSchema.safeParse(change({ field: 'score' })).success).toBe(false);
    expect(CourseChangeSchema.safeParse(change({ courseId: 'abc' })).success).toBe(false);
    expect(CourseChangeSchema.safeParse(change({ at: 'yesterday' })).success).toBe(false);
  });
});

describe('unseen changes and the dismiss marker', () => {
  const early = change({ at: '2026-10-30T01:00:00.000Z' });
  const late = change({ at: '2026-10-31T01:00:00.000Z', assessmentId: 'a2' });
  const other = change({ at: '2026-10-30T12:00:00.000Z', courseId: '200' });

  it('shows changes after the marker, of courses in the course list only', () => {
    expect(unseenChanges([late, other, early], null, ['100', '200'])).toEqual([late, other, early]);
    expect(unseenChanges([late, other, early], '2026-10-30T01:00:00.000Z', ['100', '200'])).toEqual([late, other]);
    expect(unseenChanges([late, other, early], null, ['100'])).toEqual([late, early]);
    // An unreadable marker counts as absent: everything is unseen.
    expect(unseenChanges([early], 'not a date', ['100'])).toEqual([early]);
  });

  it('orders newest time first and, within one time, in logged order', () => {
    // The API lists the log newest line first: `second` was logged after `first` in the same run.
    const first = change({ assessmentId: 'a1' }), second = change({ assessmentId: 'a2' });
    expect(unseenChanges([second, first, late], null, ['100'])).toEqual([late, first, second]);
  });

  it('lets the course page dismiss only when no other course has an unseen change up to that time', () => {
    expect(courseDismissAt([late, early], '100')).toBe('2026-10-31T01:00:00.000Z');
    expect(courseDismissAt([late, other, early], '100')).toBeNull();
    // Course 100's earlier change would be hidden by course 200's marker, so course 200 cannot dismiss either.
    expect(courseDismissAt([late, other, early], '200')).toBeNull();
    expect(courseDismissAt([late, other], '200')).toBe('2026-10-30T12:00:00.000Z');
    expect(courseDismissAt([other], '100')).toBeNull();
  });
});
