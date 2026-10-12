import { z } from 'zod';
import { CourseSchema, AssessmentSchema, TaskSchema, StepSchema, CitationSchema, RunSchema, ChangeSchema } from '../domain/schemas.js';
import { ChangesInputSchema, ChangesOutputSchema } from '../sync/changes-handler.js';
import { targetSchema } from '../quiz/read/contracts.js';
import { quizOutputSchema } from '../quiz/read/questions.js';
import { policySchema, grantSchema, prerequisiteSchema } from '../quiz/policy.js';
import { proposalSchema } from '../quiz/proposals.js';
import { recordSchema, requestSchema, pageSchema } from '../quiz/review.js';
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
// Hashes and citation offsets refer to this exact redacted text; validation must not transform it.
const sourceText = z.string().min(1).max(100000).refine(value => value.trim().length > 0);
export const SourceEvidenceSchema = z.strictObject({ sourceItemId: IdSchema, courseId: IdSchema, text: sourceText,
  sourceHash: HashSchema, locator: text, page: z.number().int().positive().safe().optional(),
  provenance: z.enum(['canvas', 'ed', 'manual']), redacted: z.literal(true) });
export const CoverageSchema = z.strictObject({ complete: z.boolean(), gaps: z.array(z.strictObject({
  code: z.enum(['MISSING_EVIDENCE', 'UNSUPPORTED', 'INCOMPLETE']), reference: IdSchema.optional(),
})).max(500) });
function page<S extends z.ZodType>(item: S) {
  return z.strictObject({ items: z.array(item).max(500), nextCursor: CursorSchema.optional(),
    evidence: z.array(SourceEvidenceSchema).max(500), coverage: CoverageSchema });
}
const courseWeek = { courseId: IdSchema, week: z.number().int().min(1).max(53).optional() };
const studyWrite = { ...courseWeek, sourceRevision: HashSchema, previousRevision: z.uuid().optional() };
const receipt = z.strictObject({ id: IdSchema, revision: z.uuid(), sourceRevision: HashSchema,
  citations: z.array(VerifiedCitationSchema).min(1).max(500), limitations: z.array(text).max(100) });
export const RevisionRecordSchema = z.strictObject({ id: IdSchema, revision: z.uuid(), ...studyWrite,
  claims: z.array(ClaimSchema).min(1).max(300), citations: z.array(VerifiedCitationSchema).min(1).max(500),
  limitations: z.array(text).max(100) });
export const PracticeQuestionSchema = z.strictObject({ id: IdSchema, prompt: text,
  kind: z.enum(['objective', 'open']), options: z.array(z.strictObject({ id: IdSchema, text })).min(2).max(100).optional(),
  answer: text, explanation: z.array(ClaimSchema).min(1).max(100) }).refine(q => q.kind !== 'objective' || q.options !== undefined);
export const PracticeRecordSchema = z.strictObject({ id: IdSchema, revision: z.uuid(), ...studyWrite,
  questions: z.array(PracticeQuestionSchema).min(1).max(300), citations: z.array(VerifiedCitationSchema).min(1).max(500),
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
  courseId: IdSchema.optional(), assessmentId: IdSchema.optional(), revision: z.uuid().optional(), policyRef: HashSchema.optional(), grantRef: HashSchema.optional() });
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
/** The confirmation is minted/consumed by a trusted server service, never by a request flag. */
export const FilledTargetSchema = z.strictObject({ assessmentId: IdSchema, revision: z.uuid(), sourceRevision: HashSchema,
  page: pageSchema.extend({ course: pageSchema.shape.course.unwrap(), lesson: pageSchema.shape.lesson.unwrap() }),
  policyRef: HashSchema, grantRef: HashSchema, filledRevision: z.uuid() });
export type FilledTarget = z.infer<typeof FilledTargetSchema>;
export const ConfirmationSchema = z.strictObject({ token: CursorSchema, target: FilledTargetSchema, expiresAt: z.iso.datetime() });
export type Confirmation = z.infer<typeof ConfirmationSchema>;
const actionTarget = FilledTargetSchema.omit({ filledRevision: true });
const actionOutcome = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('filled'), target: FilledTargetSchema }),
  z.strictObject({ status: z.literal('submitted'), target: FilledTargetSchema }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('SOURCE_UNAVAILABLE') }),
  z.strictObject({ status: z.enum(['partial', 'uncertain']), target: actionTarget, retrySafe: z.literal(false) }),
]);
const recorded = (kind: 'policy' | 'grant' | 'prerequisites') => z.strictObject({ recorded: z.literal(kind) });
export const PolicyReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ recorded: z.literal('policy'), policyRef: HashSchema, courseId: IdSchema,
    status: z.enum(['allowed', 'owner-attested']), cap: z.union([z.literal(2), z.literal(3), z.literal(4)]), recordedAt: z.iso.datetime() }),
  z.strictObject({ recorded: z.literal('policy'), policyRef: HashSchema, courseId: IdSchema,
    status: z.literal('prohibited'), cap: z.literal(1), recordedAt: z.iso.datetime() }),
]);
export const GrantReceiptSchema = z.strictObject({ recorded: z.literal('grant'), grantRef: HashSchema,
  courseId: IdSchema, assessmentId: IdSchema, category: GrantRecordSchema.shape.category,
  level: LevelSchema, recordedAt: z.iso.datetime() });
const courses = { input: z.strictObject({ ...paging, term: text.optional() }), output: page(CourseSchema.strict()), level: 0 } as const;
const policy = { input: PolicyRecordSchema, output: PolicyReceiptSchema, level: 0 } as const;
const grant = { input: GrantRecordSchema, output: GrantReceiptSchema, level: 0 } as const;
export const contracts = {
  'courses.list': courses,
  'assessments.list': { input: z.strictObject({ ...paging, courseId: IdSchema.optional(), kind: AssessmentSchema.shape.kind.optional(), status: AssessmentSchema.shape.status.optional() }), output: page(AssessmentSchema.strict()), level: 0 },
  'tasks.list': { input: z.strictObject({ ...paging, courseId: IdSchema.optional(), assessmentId: IdSchema.optional(), moduleId: IdSchema.optional() }), output: page(task), level: 0 },
  'sources.get': { input: z.strictObject({ sourceItemId: IdSchema }), output: SourceEvidenceSchema, level: 0 },
  'materials.list': { input: z.strictObject({ ...paging, courseId: IdSchema, sourceItemId: IdSchema.optional(), page: z.number().int().positive().safe().optional() }), output: page(SourceEvidenceSchema), level: 0 },
  changes: { input: ChangesInputSchema, output: ChangesOutputSchema.safeExtend({ changes: z.array(ChangeSchema.strict()).max(500) }), level: 0 },
  'runs.list': { input: z.strictObject({ ...paging, command: IdSchema.optional(), outcome: z.enum(['ok', 'error']).optional() }), output: page(RunSchema.strict()), level: 0 },
  'revision.list': { input: z.strictObject({ ...paging, ...courseWeek, revision: z.uuid().optional() }), output: page(RevisionRecordSchema), level: 0 },
  'practice.list': { input: z.strictObject({ ...paging, ...courseWeek, revision: z.uuid().optional() }), output: page(PracticeRecordSchema), level: 0 },
  'proposals.get': { input: z.strictObject({ assessmentId: IdSchema, revision: z.uuid().optional() }), output: recordSchema, level: 0 },
  'breakdown.write': { input: z.strictObject({ assessmentId: IdSchema, sourceRevision: HashSchema, previousRevision: z.uuid().optional(), task: breakdown }).refine(i => i.assessmentId === i.task.assessmentId), output: receipt, level: 1 },
  'revision.write': { input: z.strictObject({ ...studyWrite, claims: z.array(ClaimSchema).min(1).max(300) }), output: receipt, level: 1 },
  'practice.write': { input: z.strictObject({ ...studyWrite, questions: z.array(PracticeQuestionSchema).min(1).max(300) }), output: receipt, level: 1 },
  'quiz.propose': { input: proposalSchema, output: z.strictObject({ assessmentRef: IdSchema, revision: z.uuid(), sourceRevision: HashSchema, evidence: z.array(z.enum(['prompt-only', 'course-material'])).min(1).max(300) }), level: 2 },
  'quiz.read': { input: targetSchema, output: quizOutputSchema, level: 0 },
  'quiz.review': { input: requestSchema, output: z.strictObject({ status: z.enum(['approved', 'rejected', 'cancelled', 'timed-out']), revision: z.uuid() }), level: 0 },
  'quiz.prerequisites': { input: prerequisiteSchema, output: recorded('prerequisites'), level: 0 },
  'policy.record': policy,
  'grant.record': grant,
  'quiz.policy': { ...policy, input: policySchema, output: recorded('policy') },
  'quiz.grant': { ...grant, input: grantSchema, output: recorded('grant') },
  'audit.list': { input: z.strictObject({ ...paging, assessmentId: IdSchema.optional(), command: IdSchema.optional() }), output: page(AuditRecordSchema), level: 0 },
  'quiz.fill': { input: actionTarget, output: z.discriminatedUnion('status', [actionOutcome.options[0], actionOutcome.options[2], actionOutcome.options[3]]), level: 3 },
  'quiz.submit': { input: FilledTargetSchema.extend({ confirmationToken: CursorSchema.optional() }), output: z.discriminatedUnion('status', [actionOutcome.options[1], actionOutcome.options[2], actionOutcome.options[3]]), level: 4 },
} as const;
export type CommandName = keyof typeof contracts;
export type CommandInput<N extends CommandName> = z.input<(typeof contracts)[N]['input']>;
export type ParsedCommandInput<N extends CommandName> = z.output<(typeof contracts)[N]['input']>;
export type CommandOutput<N extends CommandName> = z.output<(typeof contracts)[N]['output']>;
export const ownerCommands: ReadonlySet<string> = new Set(['policy.record', 'grant.record', 'quiz.policy', 'quiz.grant', 'quiz.review', 'quiz.prerequisites']);
const meta = z.strictObject({ runId: z.uuid(), durationMs: z.number().nonnegative() });
export const FailureEnvelopeSchema = z.strictObject({ protocol: z.literal('coursework.agent/v1'), command: z.string(), meta,
  ok: z.literal(false), error: z.strictObject({ code: z.enum(Object.keys(retryable) as (keyof typeof retryable)[]), message: z.string(), retryable: z.boolean(), next: z.string().optional() }) }).refine(e => e.error.retryable === retryable[e.error.code]);
export function envelopeSchema<N extends CommandName>(name: N) {
  return z.union([z.strictObject({ protocol: z.literal('coursework.agent/v1'), command: z.literal(name), meta,
    ok: z.literal(true), data: contracts[name].output }), FailureEnvelopeSchema.refine(e => e.command === name)]);
}
