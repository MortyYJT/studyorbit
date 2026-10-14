// Invented entities for the v1 delivery schema and store scenarios.
export const at = '2026-01-01T00:00:00Z';
export const citation = { sourceItemId: 'source-1', quote: 'Fictional requirement.', locator: 'paragraph 1' };
export const delivery = {
  AssessmentLink: { assessmentId: 'a', sourceItemId: 'source-1', origin: 'agent', at },
  Annotation: { id: 'annotation-1', entity: 'assessment', entityId: 'a', field: 'kind', value: 'quiz', origin: 'agent', citations: [citation], at },
  AnnotationVerdict: { annotationId: 'annotation-1', verdict: 'correct', at },
  PlanningSettings: { timeZone: 'Australia/Melbourne', weekdayMinutes: [60, 60, 60, 60, 60, 0, 0], teachingWeekAnchor: '2026-02-02', breakWeeks: [6] },
  Estimate: { workId: 'a', minutes: 60, origin: 'agent', reason: 'Two fictional sections', at },
  StartTime: { workId: 'a', date: '2026-02-02', time: '09:30', at },
  TimeLog: { workId: 'a', minutes: 25, at },
  CourseAutonomy: { courseId: 'course-1', defaultLevel: 2, confirmBeforeSubmit: true, at },
  Conversation: { id: 'conversation-1', title: 'Fictional chat', adapter: 'synthetic', sessionRef: 'session-1', courseId: 'course-1', assessmentId: 'a', preset: 'prepare', createdAt: at, updatedAt: at },
  Message: { id: 'message-1', conversationId: 'conversation-1', seq: 1, role: 'agent', parts: [{ type: 'text', text: 'Fictional reply' }, { type: 'tool_step', tool: 'source.read', input: { id: 'source-1' }, output: { text: 'Fictional requirement.' } }, { type: 'confirmation', confirmationId: 'confirmation-1' }], stopped: false, at },
  PendingConfirmation: { id: 'confirmation-1', conversationId: 'conversation-1', assessmentId: 'a', summary: 'Fictional submit', screenshotRef: 'screen-1', state: 'confirmed', createdAt: at, decidedAt: at },
  PracticeAttempt: { questionId: 'question-1', revision: '00000000-0000-4000-8000-000000000001', outcome: 'incorrect', at },
} as const;
