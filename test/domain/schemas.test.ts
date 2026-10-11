import { describe, expect, it } from 'vitest';
import {
  ModuleSchema, CourseSchema, AssessmentSchema, SourceItemSchema,
  CitationSchema, StepSchema, TaskSchema, ChangeSchema, RunSchema,
} from '../../src/domain/schemas.js';

const step = { title: 'Read fictional brief', estimateMinutes: 15, done: false, citations: [] };
const task = { id: 'task-1', moduleId: 'module-1', title: 'Synthetic task', source: 'manual', steps: [step] };
const citation = { sourceItemId: 'source-1', quote: 'A fictional requirement.', locator: 'paragraph 1' };
const assessment = { id: 'assessment-1', courseId: 'course-1', name: 'Fictional assignment', kind: 'assignment', weight: 40, isFinal: false, status: 'not_started' };
const at = '2026-01-01T00:00:00Z';

describe('entity schemas', () => {
  it('valid entity is accepted', () => {
    expect(TaskSchema.parse(task)).toEqual(task);
  });
  it('invalid entity is rejected with the title path', () => {
    const { title: _title, ...withoutTitle } = task;
    const result = TaskSchema.safeParse(withoutTitle);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(i => i.path)).toContainEqual(['title']);
  });
  it('unknown platform enum is rejected with a path', () => {
    const result = SourceItemSchema.safeParse({ id: 'source-1', platform: 'moodle', externalId: 'external-1', kind: 'material', title: 'Synthetic brief', text: '', contentHash: 'fake-hash', fetchedAt: at });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(i => i.path)).toContainEqual(['platform']);
  });
  it('weight out of range is rejected', () => {
    expect(AssessmentSchema.safeParse({ ...assessment, weight: 120 }).success).toBe(false);
  });
  it('coursework step without a citation is rejected', () => {
    expect(TaskSchema.safeParse({ ...task, source: 'coursework' }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, source: 'coursework', steps: [{ ...step, citations: [citation] }] }).success).toBe(true);
  });
  it('manual steps cannot have citations', () => {
    expect(TaskSchema.safeParse({ ...task, steps: [{ ...step, citations: [citation] }] }).success).toBe(false);
  });
  it.each(['daily', 'weekly'])('recurring %s task cannot have a due date', repeat => {
    expect(TaskSchema.safeParse({ ...task, repeat, due: at }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, repeat }).success).toBe(true);
  });
  it('task needs at least one step', () => {
    expect(TaskSchema.safeParse({ ...task, steps: [] }).success).toBe(false);
  });
  it('parses every entity and nested schema', () => {
    expect(ModuleSchema.parse({ id: 'module-1', name: 'Synthetic study', glyph: 'book', auto: true }).auto).toBe(true);
    expect(CourseSchema.parse({ id: 'course-1', moduleId: 'module-1', code: 'COMP90099', name: 'Fictional computing', term: '2026-S1', assessmentsComplete: false }).code).toBe('COMP90099');
    expect(AssessmentSchema.parse({ ...assessment, score: 80, hurdleMin: 40, due: at }).score).toBe(80);
    expect(SourceItemSchema.parse({ id: 'source-1', platform: 'manual', externalId: 'external-1', courseId: 'course-1', kind: 'material', title: 'Fictional brief', url: 'https://example.invalid/brief', text: citation.quote, contentHash: 'fake-hash', fetchedAt: at }).text).toBe(citation.quote);
    expect(CitationSchema.parse(citation)).toEqual(citation);
    expect(StepSchema.parse(step)).toEqual(step);
    expect(RunSchema.parse({ id: 'run-1', command: 'sync', startedAt: at, endedAt: at, steps: 1, outcome: 'ok', costUsd: 0 }).outcome).toBe('ok');
  });
  it.each([ModuleSchema, CourseSchema, AssessmentSchema, SourceItemSchema, TaskSchema, RunSchema])('rejects an empty entity id', schema => {
    expect(schema.safeParse({ id: '' }).success).toBe(false);
  });
  it('rejects invalid percentage and timestamp values', () => {
    for (const field of ['score', 'hurdleMin']) {
      expect(AssessmentSchema.safeParse({ ...assessment, [field]: -1 }).success).toBe(false);
      expect(AssessmentSchema.safeParse({ ...assessment, [field]: 101 }).success).toBe(false);
    }
    expect(TaskSchema.safeParse({ ...task, due: 'tomorrow' }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, due: '2026-01-01T12:00:00+10:00' }).success).toBe(true);
  });
});

describe('change snapshots', () => {
  const change = { seq: 1, entity: 'task', entityId: 'task-1', at };
  it('change without before or added with before is rejected', () => {
    expect(ChangeSchema.safeParse({ ...change, kind: 'updated', after: { due: at } }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind: 'created', before: task, after: task }).success).toBe(false);
  });
  it.each(['updated'])('%s requires both snapshots', kind => {
    expect(ChangeSchema.safeParse({ ...change, kind, before: {}, after: {} }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...change, kind, before: {} }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind, after: {} }).success).toBe(false);
  });
  it('added requires only after and removed requires only before', () => {
    expect(ChangeSchema.safeParse({ ...change, kind: 'created', after: task }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...change, kind: 'created' }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind: 'deleted', before: task }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...change, kind: 'deleted', before: task, after: task }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind: 'deleted' }).success).toBe(false);
  });
});


describe('supported source providers (2.1)', () => {
  const source = { id: 'source-1', externalId: 'external-1', kind: 'material', title: 'Synthetic brief', text: '', contentHash: 'fake-hash', fetchedAt: at };
  it.each(['canvas', 'ed', 'manual'])('accepts %s without changing other fields', platform => {
    expect(SourceItemSchema.parse({ ...source, platform })).toEqual({ ...source, platform });
  });
  it('rejects legacy iCal at platform', () => {
    const result = SourceItemSchema.safeParse({ ...source, platform: 'ical' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.path)).toContainEqual(['platform']);
  });
});


it('rejects historical specialized operations outside migration and invalid seq (2.2)', () => {
  for (const kind of ['item.added', 'item.removed', 'content.changed', 'deadline.changed', 'grade.changed']) {
    expect(ChangeSchema.safeParse({ seq: 1, kind, entity: 'task', entityId: 'task-1', before: {}, after: {}, at }).success).toBe(false);
  }
  for (const seq of [0, -1, 1.5, Infinity, undefined]) {
    expect(ChangeSchema.safeParse({ seq, kind: 'created', entity: 'task', entityId: 'task-1', after: {}, at }).success).toBe(false);
  }
});
