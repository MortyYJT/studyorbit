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
});

export const AssessmentSchema = z.object({
  id: IdSchema,
  courseId: IdSchema,
  name: z.string(),
  kind: z.enum(['ongoing', 'assignment', 'exam']),
  weight: PercentSchema,
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
}).superRefine((task, ctx) => {
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

export const ChangeSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(['created', 'updated', 'deleted']),
  entity: z.enum(['course', 'assessment', 'source_item', 'task']),
  entityId: IdSchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  at: TimeSchema,
}).superRefine((change, ctx) => {
  const needsBefore = change.kind !== 'created';
  const needsAfter = change.kind !== 'deleted';
  for (const [field, required] of [['before', needsBefore], ['after', needsAfter]] as const) {
    if ((change[field] !== undefined) !== required) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${change.kind} ${required ? 'requires' : 'forbids'} ${field}` });
    }
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
  pages: measurements.pages.optional(),
  requests: measurements.requests.optional(),
  failures: measurements.failures.optional(),
  coverage: measurements.coverage.optional(),
}).superRefine((run, ctx) => {
  const fields = ['pages', 'requests', 'failures', 'coverage'] as const;
  if (fields.some(field => run[field] !== undefined)) {
    for (const field of fields) {
      if (run[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Measured runs require all measurement fields' });
    }
  }
});
export const SyncRunSchema = RunBaseSchema.extend({ command: z.literal('sync'), ...measurements });

export type Module = z.infer<typeof ModuleSchema>;
export type Course = z.infer<typeof CourseSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
export type SourceItem = z.infer<typeof SourceItemSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Change = z.infer<typeof ChangeSchema>;
export type Run = z.infer<typeof RunSchema>;
