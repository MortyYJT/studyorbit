import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CORRECTION_LIMITS, StoreSchema, applyOwnerEdit, assessmentFields, conflictId, dropImportNoise, isCourseId, normaliseCorrections,
  parseCorrectionsInput, parseKey, pruneConflicts, sameValue, sha256Hex, transitionConflicts, type CorrectionStore, type Fields,
} from '../shared/corrections.js';
import type { CourseDocumentV1, CourseDocumentV2 } from '../shared/course-data.js';

// Synthetic course IDs, names and dates only (openspec/changes/archive/2026-10-29-local-corrections-merge, PR 1).
const source = (url: string | null) => ({ platform: 'canvas' as const, url, evidence: null });
const v1Item = (id: string, patch: Partial<CourseDocumentV1['assessments'][number]> = {}): CourseDocumentV1['assessments'][number] => ({
  id, name: `Synthetic ${id}`, kind: 'assignment', nature: 'regular', parentId: null, weight: 20, score: null, maxScore: null,
  due: '2026-11-10T12:59:00Z', status: 'not_started', scoring: 'none', rule: null, sources: [], ...patch,
});
const v1 = (assessments: CourseDocumentV1['assessments']): CourseDocumentV1 => ({
  version: 1, course: { id: '100', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' }, assessments, materials: [],
});
const fields = (patch: Partial<Fields> = {}): Fields => ({
  name: 'Synthetic', kind: 'assignment', nature: 'regular', weight: 20, score: null, outOf: null, due: '2026-11-10T12:59:00Z',
  status: 'not_started', rule: null, scoring: 'none', parent: null, link: null, ...patch,
});
const store = (patch: Partial<CorrectionStore> = {}): CorrectionStore => ({
  version: 1, courseId: '100', revision: 1, base: { digest: 'd1', assessments: { a1: fields(), a2: fields({ name: 'Second' }) } },
  corrections: {}, manual: [], order: [], pins: {}, conflicts: [], updatedAt: '2026-10-30T00:00:00.000Z', ...patch,
});

describe('course IDs and keys', () => {
  it('accepts Canvas-style numeric course IDs only', () => {
    expect(isCourseId('100')).toBe(true);
    expect(isCourseId('1'.repeat(20))).toBe(true);
    for (const bad of ['../x', '', '1'.repeat(21), '10a', ' 100', 100]) expect(isCourseId(bad)).toBe(false);
  });

  it('tells item, group and manual keys apart', () => {
    expect(parseKey('100:canvas:5551', '100')).toEqual({ type: 'item', id: 'canvas:5551' });
    expect(parseKey('100:group:100:canvas-group:300', '100')).toEqual({ type: 'group', id: 'canvas-group:300' });
    expect(parseKey('100:manual:m1', '100')).toEqual({ type: 'manual' });
    // A manual item can be a parent; its group row edits are manual too.
    expect(parseKey('100:group:100:manual:m1', '100')).toEqual({ type: 'manual' });
    expect(parseKey('100:group:200:a1', '100')).toBeNull();
    expect(parseKey('200:a1', '100')).toBeNull();
    expect(parseKey('100:', '100')).toBeNull();
  });
});

describe('input and store schemas', () => {
  it('accepts the corrections the page writes today', () => {
    const parsed = parseCorrectionsInput('100', {
      corrections: {
        '100:a1': { name: 'A1', kind: 'exam', nature: 'regular', rule: '', weight: null, score: 5, outOf: 10, due: null, parent: '', status: '', link: '', scoring: 'points' },
        '100:a2': { hidden: true, mergeInto: '100:a1', bonus: false },
      },
      manual: [{ key: '100:manual:m1', name: 'Manual item', weight: '10%', sources: [] }],
      order: ['100:a1', '100:group:100:a2'],
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejects unknown fields, wrong types, foreign keys and bad manual items', () => {
    const bad = [
      { corrections: { '100:a1': { colour: 'red' } }, manual: [], order: [] },
      { corrections: { '100:a1': { weight: '20' } }, manual: [], order: [] },
      { corrections: { '100:a1': { kind: 'test' } }, manual: [], order: [] },
      { corrections: { '200:a1': { weight: 20 } }, manual: [], order: [] },
      { corrections: { '100:a1': null }, manual: [], order: [] },
      { corrections: {}, manual: [{ key: '200:manual:m1', name: 'x' }], order: [] },
      { corrections: {}, manual: [{ key: '100:manual:m1', name: '' }], order: [] },
      { corrections: {}, manual: [{ key: '100:a1', name: 'x' }], order: [] },
      { corrections: {}, manual: [], order: [1] },
      { corrections: {}, manual: [] },
      { corrections: {}, manual: [], order: [], extra: 1 },
    ];
    for (const input of bad) expect(parseCorrectionsInput('100', input)).toEqual({ ok: false, error: 'INVALID_BODY' });
  });

  it('requires a revision only when asked, as a non-negative integer', () => {
    const body = { corrections: {}, manual: [], order: [] };
    expect(parseCorrectionsInput('100', { ...body, revision: 0 }, { revision: true }).ok).toBe(true);
    expect(parseCorrectionsInput('100', body, { revision: true }).ok).toBe(false);
    expect(parseCorrectionsInput('100', { ...body, revision: -1 }, { revision: true }).ok).toBe(false);
    expect(parseCorrectionsInput('100', { ...body, revision: 1.5 }, { revision: true }).ok).toBe(false);
    expect(parseCorrectionsInput('100', { ...body, revision: 0 }).ok).toBe(false);
  });

  it('enforces the per-course size limits', () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`100:a${index}`, { weight: 1 }]));
    expect(parseCorrectionsInput('100', { corrections: many(CORRECTION_LIMITS.corrections), manual: [], order: [] }).ok).toBe(true);
    expect(parseCorrectionsInput('100', { corrections: many(CORRECTION_LIMITS.corrections + 1), manual: [], order: [] })).toEqual({ ok: false, error: 'TOO_LARGE' });
    const manual = Array.from({ length: CORRECTION_LIMITS.manual + 1 }, (_, index) => ({ key: `100:manual:${index}`, name: 'x' }));
    expect(parseCorrectionsInput('100', { corrections: {}, manual, order: [] })).toEqual({ ok: false, error: 'TOO_LARGE' });
    const order = Array.from({ length: CORRECTION_LIMITS.order + 1 }, (_, index) => `100:a${index}`);
    expect(parseCorrectionsInput('100', { corrections: {}, manual: [], order })).toEqual({ ok: false, error: 'TOO_LARGE' });
  });

  it('validates a stored file, including pins and conflicts, and rejects other versions', () => {
    const conflict = { id: conflictId('orphaned', '100:a9', null), type: 'orphaned', key: '100:a9', assessmentId: 'a9', field: null, base: null, incoming: null, user: { weight: 5 }, detectedAt: '2026-10-30T00:00:00.000Z' };
    const good = store({ corrections: { '100:a1': { weight: 30 } }, pins: { '100:a1': ['weight'] }, conflicts: [conflict as CorrectionStore['conflicts'][number]] });
    expect(StoreSchema.safeParse(good).success).toBe(true);
    expect(StoreSchema.safeParse({ ...good, version: 2 }).success).toBe(false);
    expect(StoreSchema.safeParse({ ...good, revision: 0 }).success).toBe(false);
    expect(StoreSchema.safeParse({ ...good, courseId: '../x' }).success).toBe(false);
    expect(StoreSchema.safeParse({ ...good, corrections: { '200:a1': { weight: 1 } } }).success).toBe(false);
    expect(StoreSchema.safeParse({ ...good, pins: { '100:a1': ['colour'] } }).success).toBe(false);
  });
});

describe('assessmentFields', () => {
  it('turns a v1 document into correction vocabulary', () => {
    const doc = v1([
      v1Item('p1', { kind: 'test', status: 'unknown', maxScore: 50, sources: [source(null), source('https://canvas.example.edu/a/1'), source('https://canvas.example.edu/a/2')] }),
      v1Item('c1', { kind: 'other', parentId: 'p1', weight: null, due: null, rule: 'Best 2 of 3', scoring: 'none' }),
    ]);
    expect(assessmentFields(doc, '100')).toEqual({
      p1: fields({ name: 'Synthetic p1', kind: 'exam', status: null, outOf: 50, link: 'https://canvas.example.edu/a/1' }),
      c1: fields({ name: 'Synthetic c1', kind: 'unknown', parent: '100:p1', weight: null, due: null, rule: 'Best 2 of 3' }),
    });
  });

  it('reads a v2 document through the display conversion', () => {
    const doc: CourseDocumentV2 = {
      ...v1([]), version: 2, legacyIds: { a1: 'canvas:5551' },
      assessments: [{ ...v1Item('canvas:5551', { weight: null, score: 8, maxScore: 10, status: 'graded' }), refs: [{ platform: 'canvas', id: '5551' }], weightQuote: null, ruleQuote: null, unsourced: ['weight'] }],
    };
    expect(assessmentFields(doc, '100')).toEqual({ 'canvas:5551': fields({ name: 'Synthetic canvas:5551', weight: null, score: 8, outOf: 10, status: 'graded' }) });
  });
});

describe('sameValue', () => {
  it('treats undefined, null and blank strings as the same empty value', () => {
    expect(sameValue('rule', undefined, null)).toBe(true);
    expect(sameValue('rule', '  ', null)).toBe(true);
    expect(sameValue('parent', '', null)).toBe(true);
    expect(sameValue('weight', 0, null)).toBe(false);
    expect(sameValue('name', 'A', null)).toBe(false);
  });

  it('compares numbers to two decimal places and other text trimmed', () => {
    expect(sameValue('weight', 20, 20.001)).toBe(true);
    expect(sameValue('weight', 0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue('weight', 20, 20.02)).toBe(false);
    expect(sameValue('name', ' Essay ', 'Essay')).toBe(true);
    expect(sameValue('name', 'Essay', 'essay')).toBe(false);
    expect(sameValue('hidden', true, true)).toBe(true);
    expect(sameValue('hidden', false, undefined)).toBe(false);
  });

  it('compares due date-times by instant and a date-only due by its Melbourne day', () => {
    expect(sameValue('due', '2026-11-10T12:59:00Z', '2026-11-10T23:59:00+11:00')).toBe(true);
    expect(sameValue('due', '2026-11-10T12:59:00Z', '2026-11-10T13:59:00Z')).toBe(false);
    // 12:59Z on 10 November is 23:59 on 10 November in Melbourne (AEDT, +11:00).
    expect(sameValue('due', '2026-11-10', '2026-11-10T12:59:00Z')).toBe(true);
    expect(sameValue('due', '2026-11-10T12:59:00Z', '2026-11-10')).toBe(true);
    // 14:00Z on 10 November is already 11 November in Melbourne.
    expect(sameValue('due', '2026-11-10', '2026-11-10T14:00:00Z')).toBe(false);
    expect(sameValue('due', '2026-11-10', '2026-11-10')).toBe(true);
    expect(sameValue('due', '2026-11-10', '2026-11-11')).toBe(false);
    expect(sameValue('due', 'Week 12', ' Week 12 ')).toBe(true);
  });
});

describe('normaliseCorrections', () => {
  it('drops item fields equal to the base, empty statuses and empty corrections', () => {
    const result = normaliseCorrections(store({ corrections: {
      // The edit form resends every field; only the weight changed.
      '100:a1': { name: 'Synthetic', kind: 'assignment', nature: 'regular', rule: '', weight: 25, score: null, outOf: null, due: '2026-11-10T23:59:00+11:00', parent: '', status: '', link: '' },
      '100:a2': { name: 'Second', status: '' },
    } }));
    expect(result.corrections).toEqual({ '100:a1': { weight: 25 } });
  });

  it('removes an empty status even when the base has a status', () => {
    const result = normaliseCorrections(store({ base: { digest: 'd1', assessments: { a1: fields({ status: 'graded' }) } }, corrections: { '100:a1': { status: '' } } }));
    expect(result.corrections).toEqual({});
  });

  it('compares group fields with the effective item value', () => {
    const result = normaliseCorrections(store({
      base: { digest: 'd1', assessments: { 'canvas-group:300': fields({ name: 'Quizzes', weight: 30 }) } },
      corrections: {
        '100:canvas-group:300': { weight: 40 },
        // The parent form copied the corrected item weight (40) and the synced due as a date only; only the name changed.
        '100:group:100:canvas-group:300': { name: 'All quizzes', weight: 40, due: '2026-11-10', score: null, outOf: null, status: '', kind: 'assignment', scoring: 'none' },
      },
    }));
    expect(result.corrections).toEqual({ '100:canvas-group:300': { weight: 40 }, '100:group:100:canvas-group:300': { name: 'All quizzes' } });
  });

  it('keeps pinned fields, owner-only fields and manual or unknown keys', () => {
    const result = normaliseCorrections(store({
      corrections: {
        '100:a1': { weight: 20, name: 'Synthetic' },
        '100:a2': { hidden: true, mergeInto: '100:a1', bonus: false, name: 'Second' },
        '100:manual:m1': { weight: 20, status: '' },
        '100:group:200:x': { weight: 20 },
      },
      pins: { '100:a1': ['weight'], '100:a2': ['name'] },
    }));
    expect(result.corrections).toEqual({
      '100:a1': { weight: 20 }, '100:a2': { hidden: true, mergeInto: '100:a1', bonus: false, name: 'Second' },
      '100:manual:m1': { weight: 20, status: '' }, '100:group:200:x': { weight: 20 },
    });
    expect(result.pins).toEqual({ '100:a1': ['weight'], '100:a2': ['name'] });
  });

  it('drops pins whose field or correction is gone, and strips a link only when equal', () => {
    const result = normaliseCorrections(store({
      base: { digest: 'd1', assessments: { a1: fields({ link: 'https://canvas.example.edu/a/1' }) } },
      corrections: { '100:a1': { link: 'https://canvas.example.edu/a/1' }, '100:a3': { link: 'https://canvas.example.edu/a/3' } },
      pins: { '100:a1': ['weight'], '100:a9': ['name'] },
    }));
    expect(result.corrections).toEqual({ '100:a3': { link: 'https://canvas.example.edu/a/3' } });
    expect(result.pins).toEqual({});
  });

  it('keeps every field when the assessment has no base entry', () => {
    const result = normaliseCorrections(store({ base: { digest: null, assessments: {} }, corrections: { '100:a1': { weight: 20, status: '' } } }));
    expect(result.corrections).toEqual({ '100:a1': { weight: 20 } });
  });
});

describe('import noise and transition conflicts', () => {
  it('drops due: null from group corrections only', () => {
    expect(dropImportNoise({ '100:group:100:p1': { due: null, name: 'P' }, '100:a1': { due: null } }, '100'))
      .toEqual({ '100:group:100:p1': { name: 'P' }, '100:a1': { due: null } });
  });

  it('raises orphaned and dangling conflicts against a known base only', () => {
    const base = { digest: 'd1', assessments: { a1: fields() } };
    const corrections = {
      '100:a1': { parent: '100:gone', mergeInto: '100:manual:m1' },
      '100:gone': { weight: 5 },
      '100:hidden-gone': { hidden: true },
      '100:group:100:old': { name: 'Old group' },
      '100:manual:m1': { weight: 3 },
      '100:group:100:manual:m1': { name: 'Manual parent' },
    };
    const conflicts = transitionConflicts(corrections, base, '100', '2026-10-30T00:00:00.000Z');
    expect(conflicts.map(item => [item.type, item.key, item.field])).toEqual([
      ['dangling', '100:a1', 'parent'], ['orphaned', '100:gone', null], ['orphaned', '100:group:100:old', null],
    ]);
    expect(conflicts[0]).toMatchObject({ id: conflictId('dangling', '100:a1', 'parent'), assessmentId: 'a1', base: null, incoming: null, user: '100:gone' });
    expect(conflicts[1]).toMatchObject({ assessmentId: 'gone', user: { weight: 5 } });
    expect(transitionConflicts(corrections, { digest: null, assessments: {} }, '100', '2026-10-30T00:00:00.000Z')).toEqual([]);
  });

  it('derives stable conflict IDs from sha256', () => {
    expect(sha256Hex('')).toBe(createHash('sha256').update('').digest('hex'));
    const long = 'é'.repeat(100) + 'x'.repeat(57);
    expect(sha256Hex(long)).toBe(createHash('sha256').update(long).digest('hex'));
    expect(conflictId('field', '100:a1', 'weight')).toBe(createHash('sha256').update('field|100:a1|weight').digest('hex').slice(0, 16));
    expect(conflictId('orphaned', '100:a1', null)).toBe(createHash('sha256').update('orphaned|100:a1|').digest('hex').slice(0, 16));
  });
});

describe('applyOwnerEdit and pruneConflicts', () => {
  const dangling = { id: conflictId('dangling', '100:a1', 'parent'), type: 'dangling' as const, key: '100:a1', assessmentId: 'a1', field: 'parent', base: null, incoming: null, user: '100:gone', detectedAt: '2026-10-30T00:00:00.000Z' };
  const orphan = { id: conflictId('orphaned', '100:gone', null), type: 'orphaned' as const, key: '100:gone', assessmentId: 'gone', field: null, base: null, incoming: null, user: { weight: 5 }, detectedAt: '2026-10-30T00:00:00.000Z' };

  it('keeps a stored value resent in another notation, with its pin and conflict', () => {
    const current = store({ corrections: { '100:a1': { due: '2026-11-17T12:59:00Z', parent: '100:gone' } }, pins: { '100:a1': ['due'] }, conflicts: [dangling] });
    const result = applyOwnerEdit(current, { '100:a1': { due: '2026-11-17T23:59:00+11:00', parent: '100:gone', name: 'Renamed' } });
    expect(result.corrections).toEqual({ '100:a1': { due: '2026-11-17T12:59:00Z', parent: '100:gone', name: 'Renamed' } });
    expect(result.pins).toEqual({ '100:a1': ['due'] });
    expect(result.conflicts).toEqual([dangling]);
  });

  it('releases the pin and closes the conflict of a changed field, and drops state of deleted corrections', () => {
    const current = store({ corrections: { '100:a1': { weight: 30, parent: '100:gone' }, '100:gone': { weight: 5 } }, pins: { '100:a1': ['weight'] }, conflicts: [dangling, orphan] });
    const result = applyOwnerEdit(current, { '100:a1': { weight: 35, parent: '' } });
    expect(result.corrections).toEqual({ '100:a1': { weight: 35, parent: '' } });
    expect(result.pins).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it('prunes conflicts whose correction or field no longer exists', () => {
    expect(pruneConflicts([dangling, orphan], { '100:a1': { name: 'x' }, '100:gone': { weight: 5 } })).toEqual([orphan]);
  });
});
