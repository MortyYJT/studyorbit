import { z } from 'zod';
import { CourseSelectionSchema, RunSchema, SyncOutcomeSchema, type CourseSelection } from '../domain/schemas.js';

/** Sync and agent course-reading contracts (agent-course-reading). Browser-safe: the frontend client spreads them. */
const id = z.string().trim().min(1).max(256);
const count = z.number().int().nonnegative();
const time = z.iso.datetime({ offset: true });
const platform = z.enum(['canvas', 'ed']);
const warningCode = z.enum(['WEIGHT_SUM', 'REMAINDER_SHORTFALL', 'COUNT_MISMATCH']);
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
export interface SyncCommands { run(input: { course?: string }): Promise<Output<'sync.run'>>; status(): Output<'sync.status'> }
export interface CourseReadingCommands {
  offer(input: Input<'courses.offer'>): Output<'courses.offer'>;
  candidates(): CourseSelection[];
  select(input: Input<'courses.select'>): Output<'courses.select'>;
  import(input: Input<'course.import'>): Output<'course.import'>;
}
