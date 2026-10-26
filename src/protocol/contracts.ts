import { z } from 'zod';
import { CourseSchema, AssessmentSchema, TaskSchema, StepSchema, CitationSchema, RunSchema, AnnotationVerdictSchema } from '../domain/schemas.js';
import { retryable } from './errors.js';

export const IdSchema = z.string().trim().min(1).max(256);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(100000);
const count = z.number().int().nonnegative().safe();
export const LevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Level = z.infer<typeof LevelSchema>;
/** Opaque token: clients must echo it unchanged; only the owning repository interprets it. */
export const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const paging = { cursor: CursorSchema.optional(), limit: z.number().int().min(1).max(500).default(100) };
export const CitationInputSchema = CitationSchema.strict().extend({ sourceItemId: IdSchema, quote: text, locator: text });
export const VerifiedCitationSchema = CitationInputSchema.extend({ offset: count, end: count, sourceHash: HashSchema,
  page: z.number().int().positive().safe().optional() }).refine(c => c.end > c.offset);
export const ClaimSchema = z.strictObject({ text, citations: z.array(CitationInputSchema).min(1).max(100) });
// Hashes and citation offsets refer to this exact stored text; validation must not transform it.
const sourceText = z.string().min(1).max(100000).refine(value => value.trim().length > 0);
export const SourceEvidenceSchema = z.strictObject({ sourceItemId: IdSchema, courseId: IdSchema, text: sourceText,
  sourceHash: HashSchema, locator: text, page: z.number().int().positive().safe().optional(),
  provenance: z.enum(['canvas', 'ed', 'manual']), url: z.url().max(2048).optional(),
  // Set when the agent supplied the text (`source.record`): a citation shows the quote is in the recorded text, not that the page says it.
  copiedBy: z.literal('agent').optional() });
export const CoverageSchema = z.strictObject({ complete: z.boolean(), gaps: z.array(z.strictObject({
  code: z.enum(['MISSING_EVIDENCE', 'UNSUPPORTED', 'INCOMPLETE']), reference: IdSchema.optional(),
})).max(500) });
/** Field provenance is separate from the entity's creation origin. */
export const AnnotationFieldsSchema = z.record(z.string(), z.strictObject({ value: z.json(),
  origin: z.enum(['owner', 'agent', 'sync']).nullable(), annotationId: IdSchema.optional(),
  citations: z.array(z.union([VerifiedCitationSchema, CitationInputSchema])),
  verdicts: z.array(AnnotationVerdictSchema.strict()) }));
function page<S extends z.ZodType>(item: S) {
  return z.strictObject({ items: z.array(item).max(500), nextCursor: CursorSchema.optional(),
    evidence: z.array(SourceEvidenceSchema).max(500), coverage: CoverageSchema });
}
const courseWeek = { courseId: IdSchema, week: z.number().int().min(1).max(53).optional() };
const studyWrite = { ...courseWeek, sourceRevision: HashSchema, previousRevision: z.uuid().optional() };
const receipt = z.strictObject({ id: IdSchema, revision: z.uuid(), sourceRevision: HashSchema,
  citations: z.array(VerifiedCitationSchema).min(1).max(500), limitations: z.array(text).max(100) });
const revisionFields = { id: IdSchema, revision: z.uuid(), ...studyWrite,
  citations: z.array(VerifiedCitationSchema).min(1).max(500), limitations: z.array(text).max(100) };
export const ExamScopeRecordSchema = z.strictObject({ ...revisionFields, type: z.literal('exam-scope'), topics: z.array(ClaimSchema).min(1).max(300) }).refine(value => value.week === undefined, 'Exam scope is per course');
export const RevisionRecordSchema = z.union([
  z.strictObject({ ...revisionFields, type: z.literal('note').optional(), claims: z.array(ClaimSchema).min(1).max(300) }),
  ExamScopeRecordSchema,
]);
export const PracticeQuestionSchema = z.strictObject({ id: IdSchema, prompt: text,
  kind: z.enum(['objective', 'open']), options: z.array(z.strictObject({ id: IdSchema, text })).min(2).max(100).optional(),
  answer: text, explanation: z.array(ClaimSchema).min(1).max(100) }).refine(q => q.kind !== 'objective' || q.options !== undefined);
const practiceQuestions = z.array(PracticeQuestionSchema).min(1).max(300).refine(questions => new Set(questions.map(q => q.id)).size === questions.length, 'Practice question ids must be unique');
export const PracticeRecordSchema = z.strictObject({ id: IdSchema, revision: z.uuid(), ...studyWrite,
  questions: practiceQuestions, citations: z.array(VerifiedCitationSchema).min(1).max(500),
  limitations: z.array(text).max(100) });
// Strict boundary copies retain M1 refinements and inferred Task structure without changing M1.
const task = TaskSchema.strict().safeExtend({ id: IdSchema, moduleId: IdSchema, courseId: IdSchema.optional(),
  assessmentId: IdSchema.optional(), title: text, steps: z.array(StepSchema.strict().extend({
  title: text, estimateMinutes: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  citations: z.array(CitationInputSchema).max(100),
})).min(1).max(300) });
const breakdown = task.refine(t => t.source === 'coursework' && t.assessmentId !== undefined && t.courseId !== undefined);
const policyBase = { version: z.literal(1), courseId: IdSchema };
export const PolicyRecordSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...policyBase, status: z.literal('allowed'), quote: text, locator: text, cap: z.union([z.literal(2), z.literal(3), z.literal(4)]) }),
  z.strictObject({ ...policyBase, status: z.literal('prohibited'), quote: text, locator: text, cap: z.literal(1) }),
  z.strictObject({ ...policyBase, status: z.literal('owner-attested'), attestation: text, date: z.iso.date(), cap: z.union([z.literal(2), z.literal(3), z.literal(4)]) }),
]);
export const GrantRecordSchema = z.strictObject({ version: z.literal(1), courseId: IdSchema, assessmentId: IdSchema,
  category: z.enum(['assignment', 'ongoing', 'exam', 'unknown']), level: LevelSchema, date: z.iso.date() });
export const AuditRecordSchema = z.strictObject({ id: z.uuid(), runId: z.uuid(), command: IdSchema,
  phase: z.enum(['intent', 'outcome', 'denial']), at: z.iso.datetime(), code: z.enum(['OK', ...Object.keys(retryable) as (keyof typeof retryable)[]]),
  courseId: IdSchema.optional(), assessmentId: IdSchema.optional(), revision: z.uuid().optional(), policyRef: HashSchema.optional(), grantRef: HashSchema.optional(),
  level: LevelSchema.optional(), decision: z.enum(['allowed', 'denied']).optional(),
  reason: z.enum(['allowed', 'assessment-unavailable', 'policy-missing', 'course-prohibited', 'exam', 'kind-unknown',
    'grant-missing', 'grant-mismatch', 'grant-revoked', 'grant-level', 'course-cap', 'assessment-prohibited', 'authorization-unavailable', 'audit-unavailable']).optional(),
  conversationId: IdSchema.optional(), submissionState: z.enum(['cancelled', 'expired']).optional(),
  action: z.enum(['click', 'fill', 'select', 'submit', 'other']).optional(), outcome: z.enum(['success', 'failure', 'uncertain', 'violation']).optional(),
  confirmation: z.enum(['owner-chat', 'owner-ui', 'owner-terminal', 'not-required']).optional() });
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
export const PolicyReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ recorded: z.literal('policy'), policyRef: HashSchema, courseId: IdSchema,
    status: z.enum(['allowed', 'owner-attested']), cap: z.union([z.literal(2), z.literal(3), z.literal(4)]), recordedAt: z.iso.datetime() }),
  z.strictObject({ recorded: z.literal('policy'), policyRef: HashSchema, courseId: IdSchema,
    status: z.literal('prohibited'), cap: z.literal(1), recordedAt: z.iso.datetime() }),
]);
export const GrantReceiptSchema = z.strictObject({ recorded: z.literal('grant'), grantRef: HashSchema,
  courseId: IdSchema, assessmentId: IdSchema, category: GrantRecordSchema.shape.category,
  level: LevelSchema, recordedAt: z.iso.datetime() });
// `storedAt`: when the agent's last course document for this course was stored (agent-course-reading).
const effectivePolicy = z.strictObject({ value: z.enum(['allowed', 'prohibited', 'owner-attested', 'unknown']),
  origin: z.enum(['owner', 'agent', 'none']), level: z.enum(['assessment', 'course', 'none']) });
const policyRead = { policy: z.enum(['allowed', 'prohibited', 'owner-attested']).nullable().optional(),
  policyOrigin: z.enum(['owner', 'agent']).nullable().optional(), policyLevel: z.enum(['assessment', 'course']).nullable().optional(),
  effectivePolicy: effectivePolicy.optional() };
const instant = z.iso.datetime({ offset: true });
/** One saved file as the UI reads it: the file name only, never the stored path. */
export const SavedFileViewSchema = z.strictObject({
  id: IdSchema,
  name: z.string().trim().min(1).max(500),
  current: z.boolean(),
  savedAt: instant,
  supersededAt: instant.optional(),
  openedAt: instant.optional(),
  /** A current file whose earlier version was superseded and that the owner has not opened. */
  updated: z.boolean(),
});
export type SavedFileView = z.infer<typeof SavedFileViewSchema>;
const savedFiles = z.array(SavedFileViewSchema).max(20).optional();
/** The "needs you" content-updated notice; the UI opens it with `file.open` and it clears on open. */
export const UpdateNoticeSchema = z.strictObject({
  savedFileId: IdSchema,
  courseId: IdSchema,
  assessmentId: IdSchema,
  assessmentName: z.string().trim().min(1).max(100000),
  name: z.string().trim().min(1).max(500),
  savedAt: instant,
});
/** A stored conflict plus the display names the owner needs to choose; selections stay in `target`/`choice`. */
const conflictView = z.strictObject({
  id: IdSchema,
  courseId: IdSchema,
  target: z.strictObject({ componentKey: IdSchema.optional(), canvasAssignmentId: IdSchema.optional() }),
  field: z.enum(['weight', 'unmatched']),
  skeletonValue: z.json().optional(),
  canvasValue: z.json(),
  state: z.enum(['open', 'agreed', 'resolved']),
  choice: z.string().trim().min(1).max(500).optional(),
  checkedAt: instant,
  resolvedAt: instant.optional(),
  /** Weight conflicts: the course component's display name. */
  componentName: z.string().trim().min(1).max(500).optional(),
  /** Unmatched conflicts: the Canvas assignment's name from its stored value. */
  canvasName: z.string().trim().min(1).max(500).optional(),
  /** Unmatched conflicts: the course's components the owner can assign the item to. */
  components: z.array(z.strictObject({ key: IdSchema, name: z.string().trim().min(1).max(500) })).max(500).optional(),
});
const courses = { input: z.strictObject({ ...paging, term: text.optional() }), output: page(CourseSchema.strict().extend({ fields: AnnotationFieldsSchema.optional(),
  storedAt: z.iso.datetime({ offset: true }).optional(), ...policyRead })), level: 0 } as const;
const policy = { input: PolicyRecordSchema, output: PolicyReceiptSchema, level: 0 } as const;
const grant = { input: GrantRecordSchema, output: GrantReceiptSchema, level: 0 } as const;
/** A Downloads name, never a path: the move helper matches it exactly. */
const savedFileName = z.string().trim().min(1).max(300)
  .refine(name => !/[\\/]/.test(name), 'use the file name only, without a path')
  .refine(name => name !== '.' && name !== '..', 'use the saved file name, not . or ..');
const assessmentFile = z.strictObject({
  sourceItemId: IdSchema.optional(),
  name: z.string().trim().min(1).max(500),
  kind: z.enum(['html', 'pdf', 'other']),
  extracted: z.boolean(),
  /** Present only for an extracted HTML/MHTML page; bounded by the command's 64 KiB response. */
  text: z.string().max(200_000).optional(),
});
export const contracts = {
  'revision.read': { input: z.strictObject({ courseId: IdSchema }), output: z.strictObject({ sourceRevision: HashSchema, examScope: ExamScopeRecordSchema.nullable(), examTime: z.iso.datetime({ offset: true }).optional(), finalAssessmentId: IdSchema.optional() }), level: 0 },
  'practice.stats': { input: z.strictObject({ courseId: IdSchema }), output: z.strictObject({ questions: count, attempted: count, correct: count, incorrect: count, wrongQuestions: z.array(z.strictObject({ questionId: IdSchema, revision: z.uuid() })).max(500) }), level: 0 },
  'practice.attempt.record': { input: z.strictObject({ questionId: IdSchema, revision: z.uuid(), outcome: z.enum(['correct', 'incorrect', 'skipped']), at: z.iso.datetime({ offset: true }) }), output: z.strictObject({ recorded: z.literal(true) }), level: 0 },
  // The agent copies a page it read in the owner's Edge; one call per PDF page (#187).
  'source.record': { input: z.strictObject({ courseId: IdSchema, url: z.url().max(2048), title: z.string().trim().min(1).max(500),
    text: z.string().max(1_000_000), page: z.number().int().positive().max(2000).optional() }),
    // The receipt omits the text; `sources.get` reads it back. Pages are bounded to 60,000 encoded bytes (see source-record.ts).
    output: z.strictObject({ sourceItemId: IdSchema, empty: z.boolean(), locator: text, page: z.number().int().positive().safe().optional(),
      sourceHash: HashSchema, copiedBy: z.literal('agent'), sourceRevision: HashSchema }), level: 0 },
  // Start reads the deep layer: extracted page text becomes a material SourceItem linked to the assessment.
  'assessment.files': { input: z.strictObject({ assessmentId: IdSchema, saved: z.array(savedFileName).max(500).optional() }),
    output: z.strictObject({ files: z.array(assessmentFile).max(500), nothing_saved: z.boolean().optional(),
      instructions: z.string().max(4000).optional() }), level: 0 },
  'courses.list': courses,
  'assessments.list': { input: z.strictObject({ ...paging, courseId: IdSchema.optional(), kind: AssessmentSchema.shape.kind.optional(), status: AssessmentSchema.shape.status.optional() }), output: page(AssessmentSchema.strict().extend({ fields: AnnotationFieldsSchema.optional(),
    // Derived from currently linked platform items; `linked: false` means submission state is unknown.
    platform: z.strictObject({ linked: z.boolean(), submitted: z.boolean(), removed: z.boolean(),
      pointsEarned: z.number().nonnegative().optional(), pointsPossible: z.number().nonnegative().optional() }).optional(), ...policyRead,
    // Newest first, at most 20; the item's `unlockAt` comes from the stored assessment.
    savedFiles })), level: 0 },
  // Owner and agent L0 read: newest conflicts first; `all` keeps open rows plus recent resolved ones.
  'conflicts.list': { input: z.strictObject({ ...paging, courseId: IdSchema.optional(), state: z.enum(['open', 'all']).default('open') }),
    output: page(conflictView), level: 0 },
  // Owner and agent L0 read: open "assessment content updated" notices across courses.
  'updates.list': { input: z.strictObject({ ...paging }), output: page(UpdateNoticeSchema), level: 0 },
  // Owner only (frontend session or TTY); never an agent tool or an MCP tool. The path is never returned.
  'file.open': { input: z.strictObject({ savedFileId: IdSchema }),
    output: z.strictObject({ opened: z.literal(true), openedAt: instant }), level: 0 },
  'tasks.list': { input: z.strictObject({ ...paging, courseId: IdSchema.optional(), assessmentId: IdSchema.optional(), moduleId: IdSchema.optional() }), output: page(task), level: 0 },
  'sources.get': { input: z.strictObject({ sourceItemId: IdSchema }), output: SourceEvidenceSchema, level: 0 },
  'materials.list': { input: z.strictObject({ ...paging, courseId: IdSchema, sourceItemId: IdSchema.optional(), page: z.number().int().positive().safe().optional() }), output: page(SourceEvidenceSchema), level: 0 },
  'runs.list': { input: z.strictObject({ ...paging, command: IdSchema.optional(), outcome: z.enum(['ok', 'error']).optional() }), output: page(RunSchema.strict()), level: 0 },
  'revision.list': { input: z.strictObject({ ...paging, ...courseWeek, revision: z.uuid().optional() }), output: page(RevisionRecordSchema), level: 0 },
  'practice.list': { input: z.strictObject({ ...paging, ...courseWeek, revision: z.uuid().optional() }), output: page(PracticeRecordSchema), level: 0 },
  'breakdown.write': { input: z.strictObject({ assessmentId: IdSchema, sourceRevision: HashSchema, previousRevision: z.uuid().optional(), task: breakdown }).refine(i => i.assessmentId === i.task.assessmentId), output: receipt, level: 1 },
  'revision.write': { input: z.union([z.strictObject({ ...studyWrite, type: z.literal('note').optional(), claims: z.array(ClaimSchema).min(1).max(300) }), z.strictObject({ ...studyWrite, type: z.literal('exam-scope'), topics: z.array(ClaimSchema).min(1).max(300) }).refine(value => value.week === undefined, 'Exam scope is per course')]), output: receipt, level: 0 },
  'practice.write': { input: z.strictObject({ ...studyWrite, questions: practiceQuestions }), output: receipt, level: 0 },
  'policy.record': policy,
  'grant.record': grant,
  'audit.list': { input: z.strictObject({ ...paging, assessmentId: IdSchema.optional(), command: IdSchema.optional() }), output: page(AuditRecordSchema), level: 0 },
} as const;
export type CommandName = keyof typeof contracts;
export type CommandInput<N extends CommandName> = z.input<(typeof contracts)[N]['input']>;
export type ParsedCommandInput<N extends CommandName> = z.output<(typeof contracts)[N]['input']>;
export type CommandOutput<N extends CommandName> = z.output<(typeof contracts)[N]['output']>;
export const ownerCommands: ReadonlySet<string> = new Set(['sync.run', 'policy.record', 'grant.record', 'annotation.owner.record', 'annotation.confirm', 'annotation.replace', 'planning.settings.record', 'courses.select', 'check.resolve', 'file.open',
  // Long-term memory (C-4): only the owner adds, edits and deletes.
  'memory.add', 'memory.edit', 'memory.delete']);
const meta = z.strictObject({ runId: z.uuid(), durationMs: z.number().nonnegative() });
export const FailureEnvelopeSchema = z.strictObject({ protocol: z.literal('coursework.agent/v1'), command: z.string(), meta,
  ok: z.literal(false), error: z.strictObject({ code: z.enum(Object.keys(retryable) as (keyof typeof retryable)[]), message: z.string(), retryable: z.boolean(), next: z.string().optional() }) }).refine(e => e.error.retryable === retryable[e.error.code]);
export function envelopeSchema<N extends CommandName>(name: N) {
  return z.union([z.strictObject({ protocol: z.literal('coursework.agent/v1'), command: z.literal(name), meta,
    ok: z.literal(true), data: contracts[name].output }), FailureEnvelopeSchema.refine(e => e.command === name)]);
}
