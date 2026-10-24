import { z } from 'zod';
import { CourseSelectionSchema, RunSchema, SyncOutcomeSchema, CitationSchema, type CourseSelection } from '../domain/schemas.js';
import type { SyncResult } from '../sync/service.js';
// Transitional (task 4.2 replaces them): the API sync's run and status shapes.
const legacyStatus = z.enum(['OK', 'PARTIAL', 'AUTH_EXPIRED', 'LIMIT_EXCEEDED']);
const legacyCounts = { requests: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), failures: z.number().int().nonnegative() };
const legacyProvider = z.object({ status: legacyStatus, ...legacyCounts });
const legacyLast = z.object({ id: z.string(), at: z.iso.datetime({ offset: true }), status: legacyStatus, ...legacyCounts });
const legacyState = z.object({ lastRun: legacyLast.optional(), lastSuccess: legacyLast.optional() });

/** Sync and agent course-reading contracts (agent-course-reading). Browser-safe: the frontend client spreads them. */
const id = z.string().trim().min(1).max(256);
const count = z.number().int().nonnegative();
const time = z.iso.datetime({ offset: true });
const platform = z.enum(['canvas', 'ed']);
const warningCode = z.enum(['WEIGHT_SUM', 'REMAINDER_SHORTFALL']);
const paths = z.array(z.string().max(200)).max(500);
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
      warnings: z.array(warningCode).max(10), weightSum: z.number().optional(), policyChanged: z.boolean() }).optional() })).max(500),
});
export const ImportReceiptSchema = z.strictObject({ stored: z.literal(true), key: id, submission: count, courseId: id,
  components: count, items: count, assessments: count, retired: count, unknownFields: paths, dropped: paths,
  warnings: z.array(z.strictObject({ code: warningCode, sum: z.number().optional() })).max(10) });
export const syncContracts = {
  'sync.run': { input: z.strictObject({ course: z.string().regex(/^[A-Z]{4}\d{5}$/).optional() }),
    output: z.object({ run: RunSchema, providers: z.object({ canvas: legacyProvider, ed: legacyProvider }), ambiguities: z.array(z.string()), differences: z.array(z.object({ entityId: z.string(), field: z.string() })), citations: z.array(CitationSchema).max(40), details: z.object({ citations: z.number().int().nonnegative(), ambiguities: z.number().int().nonnegative(), differences: z.number().int().nonnegative() }).optional() }), level: 0 as const },
  'sync.status': { input: z.strictObject({}), output: z.object({ running: z.boolean(), canvas: legacyState, ed: legacyState }), level: 0 as const },
  /** Agent write, job-scoped: the courses seen on the Canvas and Ed dashboards and the platforms behind a sign-in page. */
  'courses.offer': { input: z.strictObject({ jobId: id, courses: z.array(z.strictObject({ code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(300).optional(), term: z.string().trim().min(1).max(20),
    pages: z.strictObject({ canvas: z.string().max(2048).optional(), ed: z.string().max(2048).optional() }) })).max(100),
    blocked: z.array(platform).max(2).default([]) }),
    output: z.strictObject({ stored: count, undecided: count, selected: count }), level: 0 as const },
  'courses.candidates': { input: z.strictObject({}), output: z.strictObject({ items: z.array(CourseSelectionSchema.strict()).max(500) }), level: 0 as const },
  /** Owner only (frontend session or TTY). */
  'courses.select': { input: z.strictObject({ selections: z.array(z.strictObject({ key: id, selected: z.boolean() })).min(1).max(100) }),
    output: z.strictObject({ recorded: count }), level: 0 as const },
  /** Agent write, job-scoped: one course document; the contract is the JSON Schema in the job prompt. */
  'course.import': { input: z.strictObject({ jobId: id, document: z.record(z.string(), z.unknown()).describe('One course document following the JSON Schema in the job prompt') }),
    output: ImportReceiptSchema, level: 0 as const },
};
export type SyncCommandName = keyof typeof syncContracts;
type Output<N extends SyncCommandName> = z.output<(typeof syncContracts)[N]['output']>;
type Input<N extends SyncCommandName> = z.output<(typeof syncContracts)[N]['input']>;
export interface SyncCommands { run(input: { course?: string }): Promise<SyncResult>; status(): Output<'sync.status'> }
export interface CourseReadingCommands {
  offer(input: Input<'courses.offer'>): Output<'courses.offer'>;
  candidates(): CourseSelection[];
  select(input: Input<'courses.select'>): Output<'courses.select'>;
  import(input: Input<'course.import'>): Output<'course.import'>;
}
