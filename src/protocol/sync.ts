import { z } from 'zod';
import { CourseSelectionSchema, RunSchema, SyncConflictSchema, SyncOutcomeSchema, type CourseSelection } from '../domain/schemas.js';

/** Sync and agent course-reading contracts (agent-course-reading). Browser-safe: the frontend client spreads them. */
const id = z.string().trim().min(1).max(256);
const count = z.number().int().nonnegative();
const time = z.iso.datetime({ offset: true });
const platform = z.enum(['canvas', 'ed']);
const warningCode = z.enum(['WEIGHT_SUM', 'REMAINDER_SHORTFALL', 'COUNT_MISMATCH']);
const paths = z.array(z.string().max(200)).max(500);

// Job-scoped stage writes (layered-sync 5.3). Bounds keep one agent call small; the refinements below
// carry the domain rules the agent must follow, with contract paths it can re-read and resubmit.
const stageText = z.string().trim().min(1).max(4000);
const stageQuote = z.string().trim().min(1).max(4000);
const stageLabel = z.string().trim().min(1).max(300);
const stageUrlText = z.string().trim().min(1).max(2048);
/** A file name as it lands in Downloads: no path separator, and never `.` or `..`. */
const stageFileName = z.string().trim().min(1).max(300)
  .refine(name => !/[\\/]/.test(name), 'use the file name only, without a path')
  .refine(name => name !== '.' && name !== '..', 'use the saved file name, not . or ..');
const stageName = z.string().trim().min(1).max(500);
const canvasId = z.string().trim().regex(/^\d+$/, 'Use the Canvas numeric id, digits only.').max(64);
const courseMapOrigins = new Set(['https://canvas.lms.unimelb.edu.au', 'https://edstem.org']);
const webOrigin = (value: string): string | undefined => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.origin : undefined; } catch { return undefined; }
};

/** The home page map: quotes for what the LMS and Ed hold, the syllabus location and same-origin links. */
export const CourseMapInputSchema = z.strictObject({
  jobId: id, courseKey: id,
  lms: z.strictObject({ text: stageText, quote: stageQuote }),
  ed: z.strictObject({ text: stageText, quote: stageQuote }),
  syllabus: z.strictObject({ where: z.enum(['canvas', 'ed', 'handbook', 'unknown']), quote: stageQuote.optional() }),
  /** No `route`: code routes each link by its URL. */
  links: z.array(z.strictObject({ label: stageLabel, url: stageUrlText, quote: stageQuote })).max(200),
  /** The course-wide AI rule, only when the home page states one; the quote is required unless unknown. */
  aiPolicy: z.strictObject({ value: z.enum(['allowed', 'prohibited', 'unknown']), quote: stageQuote.optional() }).optional(),
}).superRefine((input, ctx) => {
  if (input.syllabus.where !== 'unknown' && input.syllabus.quote === undefined) {
    ctx.addIssue({ code: 'custom', path: ['syllabus', 'quote'], message: 'a home-page quote is required unless the syllabus location is unknown' });
  }
  if (input.aiPolicy && input.aiPolicy.value !== 'unknown' && input.aiPolicy.quote === undefined) {
    ctx.addIssue({ code: 'custom', path: ['aiPolicy', 'quote'], message: 'the quoted AI statement is required unless the policy is unknown' });
  }
  input.links.forEach((link, index) => {
    if (!courseMapOrigins.has(webOrigin(link.url) ?? '')) {
      ctx.addIssue({ code: 'custom', path: ['links', index, 'url'],
        message: `link ${JSON.stringify(link.label)} (${link.url}) must be on https://canvas.lms.unimelb.edu.au or https://edstem.org` });
    }
  });
});

export const QuizzesReadInputSchema = z.strictObject({
  jobId: id, courseKey: id,
  quizzes: z.array(z.strictObject({
    id: canvasId, name: stageName, survey: z.boolean(), practice: z.boolean(),
    availability: z.strictObject({ text: stageText, quote: stageQuote }).optional(),
    description: z.strictObject({ text: stageText, quote: stageQuote }).optional(),
  })).max(500),
});

/** The AI policy with its quote and the saved file names; instructions and rubrics are never accepted. */
export const AssignmentSavedInputSchema = z.strictObject({
  jobId: id, courseKey: id, assignmentId: canvasId,
  policy: z.strictObject({ value: z.enum(['allowed', 'prohibited', 'unknown']), quote: stageQuote.optional() }),
  files: z.array(stageFileName).max(500),
}).superRefine((input, ctx) => {
  if (input.policy.value !== 'unknown' && input.policy.quote === undefined) {
    ctx.addIssue({ code: 'custom', path: ['policy', 'quote'], message: 'the quoted AI statement is required unless the policy is unknown' });
  }
});

export const MaterialsSavedInputSchema = z.strictObject({
  jobId: id, courseKey: id,
  files: z.array(stageFileName).max(500),
  /** Link-only targets such as Lecture Capture recordings; recordings are never saved as files. */
  links: z.array(z.strictObject({ label: stageLabel, url: stageUrlText })).max(500),
});

/** The Ed fallback job's lesson list: the due date is an ISO time with an offset when the page states one. */
export const EdReadInputSchema = z.strictObject({
  jobId: id, courseKey: id,
  lessons: z.array(z.strictObject({
    title: stageName, dueAt: time.optional(), quote: stageQuote,
  })).max(500),
});

const classificationCategory = z.enum(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded']);
export const ItemsClassifyInputSchema = z.strictObject({
  jobId: id, courseKey: id,
  items: z.array(z.strictObject({
    id: z.string().trim().min(1).max(256), category: classificationCategory,
    component: stageLabel.optional(), evidence: stageText,
  })).max(1000),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: 'custom', path: ['items', index, 'id'], message: `duplicate id ${JSON.stringify(item.id)}; each item appears once` });
    seen.add(item.id);
  });
});

export type CourseMapInput = z.output<typeof CourseMapInputSchema>;
export type QuizzesReadInput = z.output<typeof QuizzesReadInputSchema>;
export type AssignmentSavedInput = z.output<typeof AssignmentSavedInputSchema>;
export type MaterialsSavedInput = z.output<typeof MaterialsSavedInputSchema>;
export type EdReadInput = z.output<typeof EdReadInputSchema>;
export type ItemsClassifyInput = z.output<typeof ItemsClassifyInputSchema>;

export const SyncStatusSchema = z.strictObject({
  /** A sync job is active (its lock is held in the store). */
  running: z.boolean(),
  job: z.strictObject({ id, startedAt: time }).optional(),
  lastRun: z.strictObject({ id, startedAt: time, endedAt: time, outcome: SyncOutcomeSchema, turns: count, steps: count }).optional(),
  /** Platforms the last run found behind a sign-in page. */
  blocked: z.array(platform).max(2),
  /** Offered courses the owner has not decided yet. */
  undecided: count,
  /** Per selected course: the time of its last stored document, and what the last run reported for it. */
  courses: z.array(z.strictObject({ key: id, code: z.string(), term: z.string(), name: z.string().optional(), courseId: id.optional(),
    storedAt: time.optional(), lastRun: z.strictObject({ stored: z.boolean(), unknownFields: paths, dropped: paths,
      warnings: z.array(warningCode).max(10), weightSum: z.number().optional(), policyChanged: z.boolean(),
      /** Files the course's jobs reported as downloaded but the archive hook could not move: counts only. */
      missingFiles: count.optional() }).optional() })).max(500),
});
/** The owner's settled choices, as `check.resolve` returns them for `gradeItems`. */
export const ResolvedChoicesSchema = z.strictObject({
  weight: z.record(z.string(), z.enum(['skeleton', 'canvas'])),
  unmatched: z.record(z.string(), z.string().min(1).max(500)),
});
export const syncContracts = {
  /** Owner: start one agent reading job (Codex by default); resolves with its outcome when the job ends. */
  'sync.run': { input: z.strictObject({ course: z.string().regex(/^[A-Z]{4}\d{5}$/).optional() }),
    output: z.strictObject({ run: RunSchema, outcome: SyncOutcomeSchema }), level: 0 as const },
  'sync.status': { input: z.strictObject({}), output: SyncStatusSchema, level: 0 as const },
  /** Agent write, job-scoped: the courses seen on the Canvas and Ed dashboards and the platforms behind a sign-in page. */
  'courses.offer': { input: z.strictObject({ jobId: id, courses: z.array(z.strictObject({ code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(300).optional(), term: z.string().trim().min(1).max(20),
    pages: z.strictObject({ canvas: z.string().max(2048).optional(), ed: z.string().max(2048).optional() }) })).max(100),
    blocked: z.array(platform).max(2).default([]) }),
    output: z.strictObject({ stored: count, undecided: count, selected: count }), level: 0 as const },
  'courses.candidates': { input: z.strictObject({}), output: z.strictObject({ items: z.array(CourseSelectionSchema.strict()).max(500) }), level: 0 as const },
  /** Agent write, job-scoped: parse one Canvas API page from the clipboard; page text is never an argument. */
  'canvas.capture': { input: z.strictObject({ jobId: id, courseKey: id.optional(), page: z.enum(['courses', 'tabs', 'groups']) }),
    output: z.strictObject({ page: z.enum(['courses', 'tabs', 'groups']), stored: count.optional(), skipped: count.optional(),
      undecided: count.optional(), selected: count.optional(), tabs: count.optional(), groups: count.optional(),
      assignments: count.optional(), coverage: z.enum(['api', 'partial']).optional() }), level: 0 as const },
  /** Agent write, job-scoped: parse the copied Handbook assessment page; page text is never an argument. */
  'handbook.capture': { input: z.strictObject({ jobId: id, courseKey: id }),
    output: z.strictObject({ components: count }), level: 0 as const },
  /** Agent write, job-scoped: the home page's statements, syllabus location and links; code routes the links. */
  'course.map': { input: CourseMapInputSchema, output: z.strictObject({ links: count }), level: 0 as const },
  /** Agent write, job-scoped: the quiz list description and availability text the API does not hold. */
  'quizzes.read': { input: QuizzesReadInputSchema, output: z.strictObject({ quizzes: count }), level: 0 as const },
  /** Agent write, job-scoped: one assignment's quoted AI policy and saved file names, under `assignments.<id>`. */
  'assignment.saved': { input: AssignmentSavedInputSchema, output: z.strictObject({ files: count }), level: 0 as const },
  /** Agent write, job-scoped: downloaded file names and link-only targets, kept apart. */
  'materials.saved': { input: MaterialsSavedInputSchema, output: z.strictObject({ files: count, links: count }), level: 0 as const },
  /** Agent write, job-scoped: the Ed fallback's lesson titles and due dates, stored as the `ed` stage. */
  'ed.read': { input: EdReadInputSchema, output: z.strictObject({ lessons: count }), level: 0 as const },
  /** Agent write, job-scoped: one category and evidence per item, ids unique within the call. */
  'items.classify': { input: ItemsClassifyInputSchema, output: z.strictObject({ items: count }), level: 0 as const },
  /** Owner only (frontend session or TTY). */
  'courses.select': { input: z.strictObject({ selections: z.array(z.strictObject({ key: id, selected: z.boolean() })).min(1).max(100) }),
    output: z.strictObject({ recorded: count }), level: 0 as const },
  /** Owner only: settle one weight or unmatched conflict and return the choices `gradeItems` applies. */
  'check.resolve': { input: z.strictObject({ conflictId: id, choice: z.string().trim().min(1).max(500) }),
    output: z.strictObject({ conflict: SyncConflictSchema, choices: ResolvedChoicesSchema }), level: 0 as const },
};
export type SyncCommandName = keyof typeof syncContracts;
type Output<N extends SyncCommandName> = z.output<(typeof syncContracts)[N]['output']>;
type Input<N extends SyncCommandName> = z.output<(typeof syncContracts)[N]['input']>;
export interface SyncCommands { run(input: { course?: string }): Promise<Output<'sync.run'>>; status(): Output<'sync.status'> }
export interface CourseReadingCommands {
  offer(input: Input<'courses.offer'>): Output<'courses.offer'>;
  capture(input: Input<'canvas.capture'>): Output<'canvas.capture'>;
  handbook(input: Input<'handbook.capture'>): Output<'handbook.capture'>;
  map(input: CourseMapInput): Output<'course.map'>;
  quizzes(input: QuizzesReadInput): Output<'quizzes.read'>;
  assignmentSaved(input: AssignmentSavedInput): Output<'assignment.saved'>;
  materialsSaved(input: MaterialsSavedInput): Output<'materials.saved'>;
  edRead(input: EdReadInput): Output<'ed.read'>;
  classify(input: ItemsClassifyInput): Output<'items.classify'>;
  candidates(): CourseSelection[];
  select(input: Input<'courses.select'>): Output<'courses.select'>;
  resolve(input: Input<'check.resolve'>): Output<'check.resolve'>;
}
