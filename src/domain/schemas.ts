import { z } from 'zod';

const IdSchema = z.string().min(1);
const TimeSchema = z.iso.datetime({ offset: true });
const PercentSchema = z.number().min(0).max(100);

const FieldReadStateSchema = z.object({
  state: z.enum(['found', 'unknown', 'not_applicable', 'derived']),
  via: z.enum(['ax', 'screenshot', 'api', 'handbook']).optional(),
  checkedAt: TimeSchema.optional(),
  quote: z.string().max(2000).optional(),
  source: z.url().max(2048).optional(),
});
/** Per field: how the agent read it (#169); `derived` marks an evenly split weight (#171). */
export const ReadStateSchema = z.record(z.string(), FieldReadStateSchema);
export const AiPolicySchema = z.enum(['allowed', 'prohibited', 'owner-attested']);
export const CourseTermSchema = z.string().regex(/^\d{4}:(?:S1|S2|SUMMER|WINTER)$/);
const originUrl = (origin: string) => z.url().max(2048).refine(value => {
  try { return new URL(value).origin === origin; } catch { return false; }
}, `Must be a URL on ${origin}`);
export const CoursePagesSchema = z.object({ canvas: originUrl('https://canvas.lms.unimelb.edu.au').optional(), ed: originUrl('https://edstem.org').optional() });

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
  /** Agent-read AI policy; absent means unknown. The owner's recorded policy takes precedence (#180). */
  aiPolicy: AiPolicySchema.optional(),
  readState: ReadStateSchema.optional(),
});

type AssessmentKind = 'exam' | 'quiz' | 'assignment' | 'presentation' | 'participation' | 'ungraded';
type StoredAssessmentKind = AssessmentKind | 'ongoing';
/** Old rows and annotations store `ongoing`; every read presents `participation` (#184). */
export function normalizeAssessmentKind(value: unknown): unknown {
  return value === 'ongoing' ? 'participation' : value;
}
// Old rows store `ongoing`; parse it as `participation` while keeping the input type useful to callers.
const AssessmentKindSchema = z.preprocess(
  normalizeAssessmentKind,
  z.enum(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded']),
) as unknown as z.ZodType<AssessmentKind, StoredAssessmentKind>;

export const AssessmentSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  name: z.string(),
  kind: AssessmentKindSchema.optional(),
  weight: PercentSchema.optional(),
  origin: z.enum(['sync', 'agent', 'owner']).default('sync').optional(),
  score: PercentSchema.optional(),
  due: TimeSchema.optional(),
  /** When the platform opens the assessment (Canvas `unlock_at`). */
  unlockAt: TimeSchema.optional(),
  hurdleMin: PercentSchema.optional(),
  isFinal: z.boolean(),
  status: z.enum(['not_started', 'in_progress', 'submitted', 'graded']),
  /** Agent-read AI policy of this assessment; same values as Course, absent means unknown. */
  aiPolicy: AiPolicySchema.optional(),
  /** The grading component an item (or a component's remainder) belongs to. */
  group: z.object({ key: IdSchema, name: z.string(), weight: PercentSchema.optional(), count: z.number().int().nonnegative().optional(),
    role: z.enum(['item', 'remainder', 'component']).optional() }).optional(),
  /** No longer listed or replaced by its items; reads, planning and the grade projection omit retired assessments. */
  retired: z.boolean().optional(),
  readState: ReadStateSchema.optional(),
}).superRefine((assessment, ctx) => {
  if (assessment.kind === 'ungraded' && assessment.weight !== undefined && assessment.weight > 0) {
    ctx.addIssue({ code: 'custom', path: ['weight'], message: 'Ungraded assessments have weight 0' });
  }
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
  /** `agent` when the agent copied this text from the owner's Edge with `source.record` (#187). */
  copiedBy: z.literal('agent').optional(),
  facts: z.object({ due: TimeSchema.optional(), unlockAt: TimeSchema.optional(), pointsPossible: z.number().nonnegative().optional(),
    pointsEarned: z.number().nonnegative().optional(), submitted: z.boolean().optional(), updatedAt: TimeSchema.optional() }).optional(),
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

export const SyncOutcomeSchema = z.enum(['OK', 'PARTIAL', 'NEEDS_SELECTION', 'AGENT_UNAVAILABLE', 'TIMEOUT', 'FAILED']);
export const RunJobSchema = z.object({
  kind: IdSchema,
  courseKey: IdSchema.optional(),
  steps: CountSchema,
  turns: CountSchema,
  outcome: z.enum(['ok', 'error', 'timeout']),
  inputTokens: CountSchema.optional(),
  outputTokens: CountSchema.optional(),
});
const PlatformRunStateSchema = z.enum(['read', 'blocked', 'absent', 'unread']);
/** Counts and platform states only: no URLs, titles, names, quotes or free-form errors. */
export const CourseCoverageSchema = z.strictObject({
  courseRef: z.string().regex(/^[a-f0-9]{64}$/), stored: z.boolean(), submissions: CountSchema, unknownFields: CountSchema,
  platforms: z.strictObject({ canvas: PlatformRunStateSchema, ed: PlatformRunStateSchema }), policyChanged: z.boolean(),
  /** Whether the Canvas numbers came from the API, from a capped page, or not at all. */
  canvasNumbers: z.enum(['api', 'partial', 'unavailable']).optional(),
});
// Reads retain unmeasured historical sync runs; new finalization uses SyncRunSchema.
export const RunSchema = RunBaseSchema.extend({
  conversationId: IdSchema.optional(),
  turns: CountSchema.optional(),
  /** Agent sync jobs (agent-course-reading): turns without a conversation, the job outcome and per-course coverage. */
  syncOutcome: SyncOutcomeSchema.optional(),
  courseCoverage: z.array(CourseCoverageSchema).max(500).optional(),
  /** One record per agent job: kind, course, steps, turns, outcome and token counts when reported. */
  jobs: z.array(RunJobSchema).max(500).optional(),
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
  const agentSync = run.syncOutcome !== undefined || run.courseCoverage !== undefined || run.jobs !== undefined;
  if (agentSync) {
    for (const field of ['syncOutcome', 'courseCoverage', 'turns'] as const) {
      if (run[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Agent sync runs require syncOutcome, courseCoverage and turns' });
    }
    if (run.command !== 'sync') ctx.addIssue({ code: 'custom', path: ['command'], message: 'Only sync runs have a sync outcome' });
    if (run.conversationId !== undefined) ctx.addIssue({ code: 'custom', path: ['conversationId'], message: 'Agent sync runs have no conversation' });
  } else if ((run.conversationId === undefined) !== (run.turns === undefined)) {
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

/** An offered course and the owner's decision; `selected` is absent while undecided. */
export const CourseSelectionSchema = z.object({
  key: IdSchema, code: z.string().regex(/^[A-Z]{4}\d{5}$/), name: z.string().max(300).optional(), term: CourseTermSchema,
  pages: CoursePagesSchema, selected: z.boolean().optional(), offeredAt: TimeSchema, decidedAt: TimeSchema.optional(),
});
const SyncJobResultSchema = z.object({
  courseId: IdSchema, storedAt: TimeSchema, components: CountSchema, items: CountSchema,
  unknownFields: z.array(z.string().max(200)).max(500), dropped: z.array(z.string().max(200)).max(500),
  warnings: z.array(z.enum(['WEIGHT_SUM', 'REMAINDER_SHORTFALL', 'COUNT_MISMATCH'])).max(10), weightSum: z.number().optional(),
  platforms: z.object({ canvas: z.enum(['read', 'blocked', 'absent']), ed: z.enum(['read', 'blocked', 'absent']) }), policyChanged: z.boolean(),
});
/** Shared run state for the starting process and the `coursework mcp` process that executes the agent's commands. */
export const SyncJobSchema = z.object({
  id: IdSchema, startedAt: TimeSchema, endedAt: TimeSchema.optional(), courses: z.array(IdSchema).max(100),
  submissions: z.record(z.string(), CountSchema), outcome: SyncOutcomeSchema.optional(),
  /** Platforms the agent reported behind a sign-in page during discovery. */
  blocked: z.array(z.enum(['canvas', 'ed'])).max(2).optional(),
  /** Per course key, what the last stored document of this job produced (paths are contract paths, never page text). */
  results: z.record(z.string(), SyncJobResultSchema).optional(),
  /** Per course key, the stored result of each finished pipeline stage (JSON; no page text). */
  stages: z.record(z.string(), z.record(z.string(), z.json())).optional(),
});

export const SavedFileSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  /** Absent for course materials. */
  assessmentId: IdSchema.optional(),
  /** Path inside the owner's course folder. */
  path: z.string().min(1).max(4096),
  fingerprint: z.string().min(1).max(500),
  savedAt: TimeSchema,
  supersededAt: TimeSchema.optional(),
  /** Set when the owner opens an update notice. */
  openedAt: TimeSchema.optional(),
});

/**
 * A Canvas/skeleton disagreement. `target` names the component for `weight` conflicts and the Canvas assignment for
 * `unmatched` ones; `choice` is the owner's resolution and is valid only for its conflict kind.
 */
export const SyncConflictSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  target: z.object({ componentKey: IdSchema.optional(), canvasAssignmentId: IdSchema.optional() }),
  field: z.enum(['weight', 'unmatched']),
  skeletonValue: z.json().optional(),
  canvasValue: z.json(),
  state: z.enum(['open', 'agreed', 'resolved']),
  choice: z.string().min(1).max(500).optional(),
  checkedAt: TimeSchema,
  resolvedAt: TimeSchema.optional(),
}).superRefine((conflict, ctx) => {
  const expected = conflict.field === 'weight' ? 'componentKey' : 'canvasAssignmentId';
  const unexpected = conflict.field === 'weight' ? 'canvasAssignmentId' : 'componentKey';
  if (conflict.target[expected] === undefined) {
    ctx.addIssue({ code: 'custom', path: ['target', expected], message: `A ${conflict.field} conflict requires target.${expected}` });
  }
  if (conflict.target[unexpected] !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['target', unexpected], message: `A ${conflict.field} conflict has no target.${unexpected}` });
  }
  if (conflict.field === 'unmatched' && conflict.skeletonValue !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['skeletonValue'], message: 'An unmatched conflict has no skeleton value' });
  }
  if (conflict.choice !== undefined) {
    const valid = conflict.field === 'weight'
      ? conflict.choice === 'skeleton' || conflict.choice === 'canvas'
      : conflict.choice === 'dismissed'
        || conflict.choice !== 'skeleton' && conflict.choice !== 'canvas' && IdSchema.safeParse(conflict.choice).success;
    if (!valid) {
      ctx.addIssue({ code: 'custom', path: ['choice'], message: conflict.field === 'weight'
        ? 'A weight conflict choice is skeleton or canvas' : 'An unmatched conflict choice is a component key or dismissed' });
    }
  }
});

export type Module = z.infer<typeof ModuleSchema>;
// Historical callers may omit delivery defaults; parsing supplies them without rewriting old rows.
export type Course = z.input<typeof CourseSchema>;
export type Assessment = z.input<typeof AssessmentSchema>;
export type SourceItem = z.input<typeof SourceItemSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Task = z.input<typeof TaskSchema>;
export type Run = z.infer<typeof RunSchema>;
export type SyncOutcome = z.infer<typeof SyncOutcomeSchema>;
export type CourseCoverage = z.infer<typeof CourseCoverageSchema>;
/**
 * Long-term memory (C-4): an agent observation or an owner note. Text is stored without redaction (#191); `deletedAt` marks a
 * soft delete, after which the memory is never listed or sent to an agent again.
 */
export const MemoryKindSchema = z.enum(['habit', 'weakness', 'preference', 'other']);
export const MemorySchema = z.object({
  id: IdSchema, courseId: IdSchema.optional(), kind: MemoryKindSchema, text: z.string().min(1).max(500),
  origin: z.enum(['agent', 'owner']), conversationId: IdSchema.optional(),
  createdAt: TimeSchema, editedAt: TimeSchema.optional(), deletedAt: TimeSchema.optional(),
});
export type Memory = z.infer<typeof MemorySchema>;
export type CourseSelection = z.infer<typeof CourseSelectionSchema>;
export type SyncJob = z.infer<typeof SyncJobSchema>;
export type SavedFile = z.infer<typeof SavedFileSchema>;
export type SyncConflict = z.infer<typeof SyncConflictSchema>;
export type RunJob = z.infer<typeof RunJobSchema>;
export type SyncJobResult = z.infer<typeof SyncJobResultSchema>;
export type ReadState = z.infer<typeof ReadStateSchema>;

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
