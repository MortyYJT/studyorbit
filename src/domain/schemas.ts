import { z } from 'zod';

const IdSchema = z.string().min(1);
const TimeSchema = z.iso.datetime({ offset: true });
const PercentSchema = z.number().min(0).max(100);

export const ModuleSchema = z.object({
  id: IdSchema,
  name: z.string(),
  glyph: z.string(),
  auto: z.boolean(),
});

export const CourseSchema = z.object({
  id: IdSchema,
  moduleId: IdSchema,
  code: z.string(),
  name: z.string(),
  term: z.string(),
  assessmentsComplete: z.boolean(),
  sources: z.array(z.object({ platform: z.enum(['canvas', 'ed']), externalId: IdSchema })).default([]).optional(),
});

export const AssessmentSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  name: z.string(),
  kind: z.enum(['quiz', 'ongoing', 'assignment', 'exam']).optional(),
  weight: PercentSchema.optional(),
  origin: z.enum(['sync', 'agent', 'owner']).default('sync').optional(),
  score: PercentSchema.optional(),
  due: TimeSchema.optional(),
  hurdleMin: PercentSchema.optional(),
  isFinal: z.boolean(),
  status: z.enum(['not_started', 'in_progress', 'submitted', 'graded']),
});

export const SourceItemSchema = z.object({
  id: IdSchema,
  platform: z.enum(['canvas', 'ed', 'manual']),
  externalId: IdSchema,
  courseId: IdSchema.optional(),
  kind: z.enum(['assignment', 'announcement', 'material', 'post', 'event']),
  title: z.string(),
  url: z.url().optional(),
  text: z.string(),
  contentHash: z.string(),
  fetchedAt: TimeSchema,
  removed: z.boolean().default(false).optional(),
  facts: z.object({ due: TimeSchema.optional(), pointsPossible: z.number().nonnegative().optional(),
    pointsEarned: z.number().nonnegative().optional(), submitted: z.boolean().optional() }).optional(),
}).superRefine((source, ctx) => {
  if (source.facts !== undefined && source.kind !== 'assignment') {
    ctx.addIssue({ code: 'custom', path: ['facts'], message: 'Only assignments have facts' });
  }
});

export const CitationSchema = z.object({
  sourceItemId: IdSchema,
  quote: z.string(),
  locator: z.string(),
});

export const StepSchema = z.object({
  title: z.string(),
  estimateMinutes: z.number().nonnegative(),
  done: z.boolean(),
  citations: z.array(CitationSchema),
});

export const TaskSchema = z.object({
  id: IdSchema,
  moduleId: IdSchema,
  courseId: IdSchema.optional(),
  assessmentId: IdSchema.optional(),
  title: z.string(),
  source: z.enum(['coursework', 'manual']),
  due: TimeSchema.optional(),
  repeat: z.enum(['daily', 'weekly']).optional(),
  steps: z.array(StepSchema).min(1),
  done: z.boolean().default(false).optional(),
  allDay: z.boolean().optional(),
}).superRefine((task, ctx) => {
  if (task.allDay !== undefined && task.source !== 'manual') {
    ctx.addIssue({ code: 'custom', path: ['allDay'], message: 'Only manual tasks have allDay' });
  }
  if (task.allDay === true && task.due === undefined) {
    ctx.addIssue({ code: 'custom', path: ['due'], message: 'All-day tasks require a due date' });
  }
  task.steps.forEach((step, index) => {
    if (task.source === 'coursework' && step.citations.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'citations'], message: 'Coursework steps require a citation' });
    }
    if (task.source === 'manual' && step.citations.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'citations'], message: 'Manual steps cannot have citations' });
    }
  });
  if (task.repeat !== undefined && task.due !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['due'], message: 'Recurring tasks cannot have a due date' });
  }
});

const CountSchema = z.number().int().nonnegative();
const coverageFields = {
  // Generated opaque scope references carry no course titles, URLs or person identifiers.
  scopeRef: z.string().regex(/^[a-f0-9]{64}$/),
  planned: CountSchema,
  attempted: CountSchema,
  completed: CountSchema,
  skipped: CountSchema,
  failed: CountSchema,
  notStarted: CountSchema,
  codes: z.array(z.enum([
    'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'AUTH_EXPIRED', 'SOURCE_UNAVAILABLE',
    'LOCKED', 'CITATION_MISMATCH', 'LIMIT_EXCEEDED', 'INTERNAL',
    'CANCELED', 'INCOMPLETE', 'UNSUPPORTED', 'SKIPPED', 'NOT_STARTED',
  ])),
};
export const RunCoverageSchema = z.discriminatedUnion('provider', [
  z.strictObject({ ...coverageFields, provider: z.literal('canvas'),
    collection: z.enum(['assignments', 'assignment_groups', 'submissions', 'modules', 'files', 'materials']) }),
  z.strictObject({ ...coverageFields, provider: z.literal('ed'),
    collection: z.enum(['courses', 'lessons', 'attempts', 'slides', 'threads', 'resources', 'materials']) }),
]);
const measurements = {
  pages: CountSchema,
  requests: CountSchema,
  failures: CountSchema,
  coverage: z.array(RunCoverageSchema),
};
const RunBaseSchema = z.object({
  id: IdSchema,
  command: z.string(),
  startedAt: TimeSchema,
  endedAt: TimeSchema,
  steps: z.number().int().nonnegative(),
  outcome: z.enum(['ok', 'error']),
  errorCode: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
});

// Reads retain unmeasured historical sync runs; new finalization uses SyncRunSchema.
export const RunSchema = RunBaseSchema.extend({
  conversationId: IdSchema.optional(),
  turns: CountSchema.optional(),
  pages: measurements.pages.optional(),
  requests: measurements.requests.optional(),
  failures: measurements.failures.optional(),
  coverage: measurements.coverage.optional(),
}).superRefine((run, ctx) => {
  if (run.command === 'agent.reply') {
    for (const field of ['conversationId', 'turns'] as const) {
      if (run[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Agent replies require conversationId and turns' });
    }
  }
  if ((run.conversationId === undefined) !== (run.turns === undefined)) {
    ctx.addIssue({ code: 'custom', path: [run.conversationId === undefined ? 'conversationId' : 'turns'], message: 'Agent runs require conversationId and turns together' });
  }
  const fields = ['pages', 'requests', 'failures', 'coverage'] as const;
  if (fields.some(field => run[field] !== undefined)) {
    for (const field of fields) {
      if (run[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Measured runs require all measurement fields' });
    }
  }
});
export const SyncRunSchema = RunBaseSchema.extend({ command: z.literal('sync'), ...measurements });

export type Module = z.infer<typeof ModuleSchema>;
// Historical callers may omit delivery defaults; parsing supplies them without rewriting old rows.
export type Course = z.input<typeof CourseSchema>;
export type Assessment = z.input<typeof AssessmentSchema>;
export type SourceItem = z.input<typeof SourceItemSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Task = z.input<typeof TaskSchema>;
export type Run = z.infer<typeof RunSchema>;

const OriginSchema = z.enum(['sync', 'agent', 'owner']);
export const AssessmentLinkSchema = z.object({ assessmentId: IdSchema, sourceItemId: IdSchema, origin: OriginSchema, at: TimeSchema });
export const AnnotationSchema = z.object({
  id: IdSchema, entity: z.enum(['assessment', 'course']), entityId: IdSchema, field: IdSchema,
  value: z.json(), origin: z.enum(['agent', 'owner']), citations: z.array(CitationSchema), at: TimeSchema,
}).superRefine((annotation, ctx) => {
  if (annotation.origin === 'agent' && annotation.citations.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['citations'], message: 'Agent annotations require a citation' });
  }
});
export const AnnotationVerdictSchema = z.object({ annotationId: IdSchema, verdict: z.enum(['correct', 'incorrect']), at: TimeSchema });
export const PlanningSettingsSchema = z.object({
  timeZone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Invalid time zone'),
  weekdayMinutes: z.array(CountSchema).length(7), teachingWeekAnchor: z.iso.date(), breakWeeks: z.array(z.number().int().positive()),
});
export const EstimateSchema = z.object({ workId: IdSchema, minutes: z.number().int().positive(),
  origin: z.enum(['agent', 'owner']), reason: z.string().trim().min(1).optional(), at: TimeSchema,
}).superRefine((estimate, ctx) => {
  if (estimate.origin === 'agent' && estimate.reason === undefined) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Agent estimates require a reason' });
  }
});
export const StartTimeSchema = z.object({ workId: IdSchema, date: z.iso.date(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), at: TimeSchema });
export const TimeLogSchema = z.object({ workId: IdSchema, minutes: z.number().int().positive(), at: TimeSchema });
export const CourseAutonomySchema = z.object({ courseId: IdSchema, defaultLevel: z.number().int().min(0).max(2), confirmBeforeSubmit: z.boolean().default(true), at: TimeSchema });
export const ConversationSchema = z.object({ id: IdSchema, title: z.string(), adapter: IdSchema, sessionRef: IdSchema.optional(),
  courseId: IdSchema.optional(), assessmentId: IdSchema.optional(), preset: IdSchema.optional(), createdAt: TimeSchema, updatedAt: TimeSchema });
export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_step'), tool: IdSchema, input: z.json().optional(), output: z.json().optional() }),
  z.object({ type: z.literal('confirmation'), confirmationId: IdSchema, decision: z.enum(['pending', 'confirmed', 'cancelled', 'expired']).optional() }),
]);
export const MessageSchema = z.object({ id: IdSchema, conversationId: IdSchema, seq: CountSchema,
  role: z.enum(['owner', 'agent']), parts: z.array(MessagePartSchema), stopped: z.boolean(), at: TimeSchema });
export const PendingConfirmationSchema = z.object({ id: IdSchema, conversationId: IdSchema, assessmentId: IdSchema,
  summary: z.string(), screenshotRef: IdSchema, state: z.enum(['pending', 'confirmed', 'cancelled', 'expired']), createdAt: TimeSchema, decidedAt: TimeSchema.optional() });
export const PracticeAttemptSchema = z.strictObject({ questionId: IdSchema, revision: z.uuid(), outcome: z.enum(['correct', 'incorrect', 'skipped']), at: TimeSchema });

export type AssessmentLink = z.infer<typeof AssessmentLinkSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationVerdict = z.infer<typeof AnnotationVerdictSchema>;
export type PlanningSettings = z.infer<typeof PlanningSettingsSchema>;
export type Estimate = z.infer<typeof EstimateSchema>;
export type StartTime = z.infer<typeof StartTimeSchema>;
export type TimeLog = z.infer<typeof TimeLogSchema>;
export type CourseAutonomy = z.input<typeof CourseAutonomySchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;
export type PracticeAttempt = z.infer<typeof PracticeAttemptSchema>;
