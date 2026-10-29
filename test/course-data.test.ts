import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CourseDocumentSchema, CourseDocumentV1Schema, CourseDocumentV2Schema, CourseModelOutputSchema, toDisplayDocument } from '../shared/course-data.js';

// Synthetic course data only.
const course = { id: '900001', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' };
const v1Item = (patch: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Assignment 1', kind: 'assignment', nature: 'regular', parentId: null, weight: 20, score: 16, maxScore: 20,
  due: '2026-08-20', status: 'graded', scoring: 'none', rule: null,
  sources: [{ platform: 'canvas', url: 'https://canvas.example.edu/courses/900001/assignments/5551', evidence: null }], ...patch,
});
const v2Item = (patch: Record<string, unknown> = {}) => ({
  ...v1Item({ id: 'canvas:5551' }), refs: [{ platform: 'canvas', id: '5551' }],
  weightQuote: 'Assignment 1 Week 6 20%', ruleQuote: null, unsourced: [], ...patch,
});
const v1Doc = (assessments: unknown[] = [v1Item()]) => ({ version: 1, course, assessments, materials: [] });
const v2Doc = (assessments: unknown[] = [v2Item()], patch: Record<string, unknown> = {}) =>
  ({ version: 2, course, assessments, materials: [], legacyIds: { a1: 'canvas:5551' }, ...patch });
const messages = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map(issue => `${issue.path.join('.')}: ${issue.message}`);

describe('CourseDocumentV2Schema (stored document v2)', () => {
  it('accepts a document with refs, quotes, unsourced and legacyIds', () => {
    expect(CourseDocumentV2Schema.safeParse(v2Doc()).success).toBe(true);
    expect(CourseDocumentSchema.safeParse(v2Doc()).success).toBe(true);
  });

  it('accepts an empty legacyIds map and a group item with no refs', () => {
    const doc = v2Doc([
      v2Item({ id: 'group:quizzes', name: 'Quizzes', kind: 'quiz', refs: [], score: null, maxScore: null, due: null, status: 'unknown', weightQuote: null, weight: null, scoring: 'points' }),
      v2Item({ parentId: 'group:quizzes', weightQuote: null, weight: null }),
    ], { legacyIds: {} });
    expect(messages(CourseDocumentV2Schema.safeParse(doc))).toEqual([]);
  });

  it.each(['refs', 'weightQuote', 'ruleQuote', 'unsourced'])('rejects an assessment without %s', field => {
    const item: Record<string, unknown> = v2Item();
    delete item[field];
    expect(CourseDocumentSchema.safeParse(v2Doc([item])).success).toBe(false);
  });

  it('rejects a document without legacyIds', () => {
    const doc: Record<string, unknown> = v2Doc();
    delete doc.legacyIds;
    expect(CourseDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('is strict: unknown assessment, reference and top-level fields are rejected', () => {
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ extra: 1 })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ refs: [{ platform: 'canvas', id: '5551', url: null }] })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc(undefined, { extra: 1 })).success).toBe(false);
  });

  it('accepts only the four reference platforms and a non-empty reference ID', () => {
    for (const platform of ['canvas', 'canvas-group', 'ed', 'handbook'])
      expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ refs: [{ platform, id: '5551' }] })])).success).toBe(true);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ refs: [{ platform: 'user', id: '5551' }] })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ refs: [{ platform: 'canvas', id: '' }] })])).success).toBe(false);
  });

  it('rejects a duplicate reference on one assessment (stored refs are de-duplicated)', () => {
    const refs = [{ platform: 'canvas', id: '5551' }, { platform: 'canvas', id: '5551' }];
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ refs })])).success).toBe(false);
  });

  it('accepts only weight and rule in unsourced, each at most once', () => {
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ weight: null, weightQuote: null, rule: null, unsourced: ['weight', 'rule'] })])).success).toBe(true);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ unsourced: ['score'] })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ weight: null, weightQuote: null, unsourced: ['weight', 'weight'] })])).success).toBe(false);
  });

  it('requires an unsourced field to be cleared, and a quote to belong to a value', () => {
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ weightQuote: null, unsourced: ['weight'] })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ rule: 'Drop lowest 2', unsourced: ['rule'] })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ weight: null })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ rule: null, ruleQuote: 'drop lowest 2' })])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc([v2Item({ rule: 'Drop the lowest two', ruleQuote: 'drop lowest 2' })])).success).toBe(true);
  });

  it('rejects empty legacyIds keys or values', () => {
    expect(CourseDocumentSchema.safeParse(v2Doc(undefined, { legacyIds: { '': 'canvas:5551' } })).success).toBe(false);
    expect(CourseDocumentSchema.safeParse(v2Doc(undefined, { legacyIds: { a1: '' } })).success).toBe(false);
  });

  it('applies the v1 refinements: unique IDs, score not above maximum, parent rules', () => {
    expect(messages(CourseDocumentSchema.safeParse(v2Doc([v2Item(), v2Item()])))).toContain(': assessment ids must be unique');
    expect(messages(CourseDocumentSchema.safeParse(v2Doc([v2Item({ score: 21 })])))).toContain('assessments.0.score: score exceeds maximum');
    expect(messages(CourseDocumentSchema.safeParse(v2Doc([v2Item({ parentId: 'missing' })])))).toContain('assessments.0.parentId: parent missing or cyclic');
    const nested = v2Doc([
      v2Item({ id: 'group:a', refs: [], weightQuote: null, weight: null }),
      v2Item({ id: 'group:b', refs: [], weightQuote: null, weight: null, parentId: 'group:a' }),
      v2Item({ parentId: 'group:b' }),
    ]);
    expect(messages(CourseDocumentSchema.safeParse(nested))).toContain('assessments.2.parentId: only one parent level is supported');
  });
});

describe('CourseDocumentSchema (union on version)', () => {
  it('accepts an unchanged v1 document', () => {
    const parsed = CourseDocumentSchema.safeParse(v1Doc());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.version).toBe(1);
    expect(CourseDocumentV1Schema.safeParse(v1Doc()).success).toBe(true);
  });

  it('keeps the v1 refinements for v1', () => {
    expect(messages(CourseDocumentSchema.safeParse(v1Doc([v1Item({ score: 21 })])))).toContain('assessments.0.score: score exceeds maximum');
    expect(CourseDocumentSchema.safeParse(v1Doc([v1Item(), v1Item()])).success).toBe(false);
  });

  it('does not accept v2 fields in a v1 document, or a v1 document labelled version 2', () => {
    expect(CourseDocumentSchema.safeParse(v1Doc([v2Item()])).success).toBe(false);
    expect(CourseDocumentSchema.safeParse({ ...v1Doc(), version: 2 }).success).toBe(false);
  });

  it('rejects version 3 and a missing version', () => {
    expect(CourseDocumentSchema.safeParse({ ...v2Doc(), version: 3 }).success).toBe(false);
    expect(CourseDocumentSchema.safeParse({ ...v1Doc(), version: 3 }).success).toBe(false);
    const missing: Record<string, unknown> = v1Doc();
    delete missing.version;
    expect(CourseDocumentSchema.safeParse(missing).success).toBe(false);
  });
});

describe('toDisplayDocument', () => {
  it('gives a v1 document empty refs, null quotes, empty unsourced and empty legacyIds', () => {
    const doc = CourseDocumentSchema.parse(v1Doc());
    const display = toDisplayDocument(doc);
    expect(display.version).toBe(1);
    expect(display.legacyIds).toEqual({});
    expect(display.assessments[0]).toEqual({ ...v1Item(), refs: [], weightQuote: null, ruleQuote: null, unsourced: [] });
    expect(display.course).toEqual(course);
  });

  it('passes a v2 document through unchanged', () => {
    const doc = CourseDocumentSchema.parse(v2Doc([v2Item({ weight: null, weightQuote: null, unsourced: ['weight'] })]));
    expect(toDisplayDocument(doc)).toEqual(doc);
  });

  it('does not modify its input and is idempotent', () => {
    const doc = CourseDocumentSchema.parse(v1Doc());
    const copy = structuredClone(doc);
    const display = toDisplayDocument(doc);
    expect(doc).toEqual(copy);
    expect(toDisplayDocument(display)).toEqual(display);
  });
});

describe('CourseModelOutputSchema', () => {
  const modelItem = (patch: Record<string, unknown> = {}) => ({
    key: 'a1', parentKey: null, refs: [{ platform: 'canvas', id: '5551' }], name: 'Assignment 1', kind: 'assignment', nature: 'regular',
    scoring: 'none', weight: 20, weightQuote: 'Assignment 1 Week 6 20%', rule: null, ruleQuote: null, ...patch,
  });
  const output = (assessments: unknown[] = [modelItem()], patch: Record<string, unknown> = {}) =>
    ({ version: 2, course, assessments, materials: [{ name: 'Week 1 slides', url: 'https://canvas.example.edu/files/1', platform: 'canvas' }], ...patch });

  it('accepts the allowed fields', () => {
    expect(messages(CourseModelOutputSchema.safeParse(output()))).toEqual([]);
    expect(CourseModelOutputSchema.safeParse(output([modelItem({ key: 'quizzes', refs: [] }), modelItem({ key: 'q1', parentKey: 'quizzes' })])).success).toBe(true);
  });

  it.each(['id', 'parentId', 'due', 'score', 'maxScore', 'status', 'sources', 'unsourced'])('rejects %s on an assessment', field => {
    const value = field === 'sources' || field === 'unsourced' ? [] : field === 'score' || field === 'maxScore' ? 1 : field === 'status' ? 'graded' : 'x';
    expect(CourseModelOutputSchema.safeParse(output([modelItem({ [field]: value })])).success).toBe(false);
  });

  it.each(['key', 'parentKey', 'refs', 'name', 'kind', 'nature', 'scoring', 'weight', 'weightQuote', 'rule', 'ruleQuote'])('requires %s', field => {
    const item: Record<string, unknown> = modelItem();
    delete item[field];
    expect(CourseModelOutputSchema.safeParse(output([item])).success).toBe(false);
  });

  it('requires version 2 and rejects legacyIds or unknown top-level fields', () => {
    expect(CourseModelOutputSchema.safeParse(output(undefined, { version: 1 })).success).toBe(false);
    expect(CourseModelOutputSchema.safeParse(output(undefined, { legacyIds: {} })).success).toBe(false);
    expect(CourseModelOutputSchema.safeParse(output(undefined, { extra: 1 })).success).toBe(false);
  });

  it('rejects unknown reference platforms and fields', () => {
    expect(CourseModelOutputSchema.safeParse(output([modelItem({ refs: [{ platform: 'user', id: '1' }] })])).success).toBe(false);
    expect(CourseModelOutputSchema.safeParse(output([modelItem({ refs: [{ platform: 'canvas', id: '1', url: null }] })])).success).toBe(false);
  });

  it('converts to a JSON Schema that forbids extra assessment fields', () => {
    const schema = z.toJSONSchema(CourseModelOutputSchema, { target: 'draft-7', unrepresentable: 'any' }) as unknown as {
      properties: { assessments: { items: { additionalProperties: boolean; required: string[] } } };
    };
    const items = schema.properties.assessments.items;
    expect(items.additionalProperties).toBe(false);
    expect([...items.required].sort()).toEqual(['key', 'kind', 'name', 'nature', 'parentKey', 'refs', 'rule', 'ruleQuote', 'scoring', 'weight', 'weightQuote']);
  });
});
