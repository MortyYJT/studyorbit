import { expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { delivery } from '../fixtures/delivery.js';

const operations = [
  ['AssessmentLink', 'appendAssessmentLink', 'readAssessmentLinks', ['a']],
  ['Annotation', 'appendAnnotation', 'readAnnotations', ['assessment', 'a']],
  ['AnnotationVerdict', 'appendAnnotationVerdict', 'readAnnotationVerdicts', ['annotation-1']],
  ['PlanningSettings', 'appendPlanningSettings', 'readPlanningSettings', []],
  ['Estimate', 'appendEstimate', 'readEstimates', ['a']],
  ['StartTime', 'appendStartTime', 'readStartTimes', ['a']],
  ['TimeLog', 'appendTimeLog', 'readTimeLogs', ['a']],
  ['CourseAutonomy', 'appendCourseAutonomy', 'readCourseAutonomy', ['course-1']],
  ['Conversation', 'appendConversation', 'readConversations', []],
  ['Message', 'appendMessage', 'readMessages', ['conversation-1']],
  ['PendingConfirmation', 'appendPendingConfirmation', 'readPendingConfirmations', ['conversation-1']],
  ['PracticeAttempt', 'appendPracticeAttempt', 'readPracticeAttempts', ['question-1']],
] as const;
it.each(operations)('validates and appends %s history in insertion order', (name, append, read, args) => {
  const store = new SqliteRepository(':memory:');
  const methods = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  const value = delivery[name];
  try {
    expect(methods[append]).toBeTypeOf('function');
    expect(methods[read].call(store, ...args)).toEqual([]);
    methods[append].call(store, value);
    const next = { ...value, ...('id' in value ? { id: `${value.id}-2` } : {}), ...('seq' in value ? { seq: 2 } : {}), ...('at' in value ? { at: '2026-01-02T00:00:00Z' } : {}) };
    methods[append].call(store, next);
    expect(methods[read].call(store, ...args)).toEqual([value, next]);
    const invalid = Object.fromEntries(Object.keys(value).map(key => [key, null]));
    expect(() => methods[append].call(store, invalid)).toThrow();
    expect(methods[read].call(store, ...args)).toEqual([value, next]);
    if (args.length > 0) expect(methods[read].call(store, ...args.slice(0, -1), 'unrelated')).toEqual([]);
  } finally { store.close(); }
});
