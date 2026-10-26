import { describe, expect, it } from 'vitest';
import {
  AssessmentSchema, RunSchema, SavedFileSchema, SourceItemSchema, SyncConflictSchema, SyncJobSchema,
} from '../../src/domain/schemas.js';

const at = '2026-10-24T01:00:00Z';
const assessment = {
  id: 'assessment-1', courseId: 'course-1', name: 'Synthetic presentation', kind: 'presentation',
  weight: 20, isFinal: false, status: 'not_started',
};
const source = {
  id: 'source-1', platform: 'manual', externalId: 'external-1', kind: 'assignment', title: 'Synthetic brief',
  text: '', contentHash: 'fake-hash', fetchedAt: at,
};
const file = { id: 'file-1', courseId: 'course-1', path: 'materials/week-1.pdf', fingerprint: 'fake-fingerprint', savedAt: at };
const weightConflict = {
  id: 'conflict-1', courseId: 'course-1', target: { componentKey: 'COMP90099:assignments' }, field: 'weight',
  skeletonValue: { weight: 30 }, canvasValue: { weight: 40 }, state: 'open', checkedAt: at,
};

describe('layered-sync assessment fields', () => {
  it('reads a stored ongoing kind as participation', () => {
    expect(AssessmentSchema.parse({ ...assessment, kind: 'ongoing' })).toMatchObject({ kind: 'participation' });
  });

  it.each(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded'])('accepts kind %s', kind => {
    expect(AssessmentSchema.parse({ ...assessment, kind, weight: kind === 'ungraded' ? 0 : 20 }).kind).toBe(kind);
  });

  it('accepts unlock time, item AI policy and api or handbook read states', () => {
    const parsed = AssessmentSchema.parse({ ...assessment, unlockAt: at, aiPolicy: 'prohibited',
      readState: { weight: { state: 'found', via: 'api', checkedAt: at }, kind: { state: 'found', via: 'handbook', checkedAt: at } } });
    expect(parsed.unlockAt).toBe(at);
    expect(parsed.aiPolicy).toBe('prohibited');
    expect(parsed.readState?.weight?.via).toBe('api');
    expect(parsed.readState?.kind?.via).toBe('handbook');
  });

  it('rejects an ungraded assessment with weight above zero', () => {
    const result = AssessmentSchema.safeParse({ ...assessment, kind: 'ungraded', weight: 10 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.path)).toContainEqual(['weight']);
    expect(AssessmentSchema.safeParse({ ...assessment, kind: 'ungraded', weight: 0 }).success).toBe(true);
    const { weight: _weight, ...withoutWeight } = assessment;
    expect(AssessmentSchema.safeParse({ ...withoutWeight, kind: 'ungraded' }).success).toBe(true);
  });
});

describe('layered-sync source facts and saved files', () => {
  it('accepts unlock and update facts for an assignment', () => {
    expect(SourceItemSchema.parse({ ...source, facts: { unlockAt: at, updatedAt: at } }).facts)
      .toEqual({ unlockAt: at, updatedAt: at });
    expect(SourceItemSchema.safeParse({ ...source, facts: { unlockAt: 'tomorrow' } }).success).toBe(false);
  });

  it('parses course and assessment saved files', () => {
    expect(SavedFileSchema.parse(file)).toEqual(file);
    expect(SavedFileSchema.parse({ ...file, assessmentId: 'assessment-1', supersededAt: at, openedAt: at }))
      .toMatchObject({ assessmentId: 'assessment-1', supersededAt: at, openedAt: at });
  });
});

describe('layered-sync conflicts', () => {
  it('accepts a weight conflict resolved with a skeleton or canvas choice', () => {
    expect(SyncConflictSchema.parse(weightConflict)).toEqual(weightConflict);
    expect(SyncConflictSchema.parse({ ...weightConflict, choice: 'skeleton', state: 'resolved', resolvedAt: at }).choice).toBe('skeleton');
    expect(SyncConflictSchema.parse({ ...weightConflict, choice: 'canvas' }).choice).toBe('canvas');
  });

  it('accepts an unmatched conflict resolved with a component key or dismissed', () => {
    const unmatched = { ...weightConflict, target: { canvasAssignmentId: '500001' }, field: 'unmatched',
      canvasValue: { id: '500001', name: 'Synthetic item', due: null } };
    const { skeletonValue: _skeleton, ...withoutSkeleton } = unmatched;
    expect(SyncConflictSchema.parse({ ...withoutSkeleton, choice: 'dismissed' }).choice).toBe('dismissed');
    expect(SyncConflictSchema.parse({ ...withoutSkeleton, choice: 'COMP90099:assignments' }).choice).toBe('COMP90099:assignments');
  });

  it('rejects a skeleton choice for an unmatched conflict on the choice path', () => {
    const { skeletonValue: _skeleton, ...unmatched } = { ...weightConflict, target: { canvasAssignmentId: '500001' }, field: 'unmatched',
      canvasValue: { id: '500001', name: 'Synthetic item', due: null } };
    const result = SyncConflictSchema.safeParse({ ...unmatched, choice: 'skeleton' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.path)).toContainEqual(['choice']);
  });

  it('rejects a component choice for a weight conflict on the choice path', () => {
    const result = SyncConflictSchema.safeParse({ ...weightConflict, choice: 'COMP90099:assignments' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.path)).toContainEqual(['choice']);
  });
});

describe('layered-sync run and job records', () => {
  const coverage = { courseRef: 'a'.repeat(64), stored: true, submissions: 1, unknownFields: 0,
    platforms: { canvas: 'read' as const, ed: 'read' as const }, policyChanged: false, canvasNumbers: 'api' as const };
  const run = { id: 'run-1', command: 'sync', startedAt: at, endedAt: at, steps: 3, outcome: 'ok' as const,
    turns: 4, syncOutcome: 'OK' as const, courseCoverage: [coverage],
    jobs: [{ kind: 'courses', steps: 1, turns: 1, outcome: 'ok' as const },
      { kind: 'main', courseKey: 'COMP90099:2026:S2', steps: 2, turns: 3, outcome: 'error' as const, inputTokens: 100, outputTokens: 20 }] };

  it('accepts per-job records and Canvas API coverage', () => {
    const parsed = RunSchema.parse(run);
    expect(parsed.jobs).toHaveLength(2);
    expect(parsed.courseCoverage?.[0]?.canvasNumbers).toBe('api');
  });

  it.each(['api', 'partial', 'unavailable'] as const)('accepts Canvas coverage %s', canvasNumbers => {
    expect(RunSchema.parse({ ...run, courseCoverage: [{ ...coverage, canvasNumbers }] }).courseCoverage?.[0]?.canvasNumbers).toBe(canvasNumbers);
  });

  it('rejects negative job token counts', () => {
    expect(RunSchema.safeParse({ ...run, jobs: [{ ...run.jobs[0], inputTokens: -1 }] }).success).toBe(false);
  });

  it('keeps old rows readable and adds optional per-course stage results', () => {
    const old = { id: 'job-1', startedAt: at, courses: ['COMP90099:2026:S2'], submissions: { 'COMP90099:2026:S2': 2 } };
    expect(SyncJobSchema.parse(old)).toEqual(old);
    expect(SyncJobSchema.parse({ ...old, blocked: ['canvas'], results: {},
      stages: { 'COMP90099:2026:S2': { skeleton: { weight: 30 }, main: { links: [] } } } }).stages)
      .toEqual({ 'COMP90099:2026:S2': { skeleton: { weight: 30 }, main: { links: [] } } });
  });
});
