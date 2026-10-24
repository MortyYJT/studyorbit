import { z } from 'zod';
import { AnnotationFieldsSchema, CitationInputSchema, CoverageSchema, CursorSchema, IdSchema, VerifiedCitationSchema } from '../../src/protocol/contracts.js';
import { AnnotationSchema, AnnotationVerdictSchema, AssessmentLinkSchema } from '../../src/domain/schemas.js';
import { planningInputs } from '../../src/planning/contracts.js';

// Browser copies of the annotation and autonomy contracts: their server modules import Node built-ins.
// test/web/course-contracts.test.ts keeps them identical to src/protocol/{annotations,autonomy}.ts.
const target = { entity: z.enum(['assessment', 'course']), entityId: IdSchema };
const field = z.enum(['weight', 'kind', 'hurdleMin', 'isFinal', 'name', 'due', 'assessmentsComplete', 'aiPolicy']);
const recorded = z.strictObject({ recorded: z.literal(true) });
const history = z.strictObject({ ...AnnotationSchema.shape, citations: z.array(z.union([VerifiedCitationSchema, CitationInputSchema])),
  verdicts: z.array(AnnotationVerdictSchema.strict()), coverage: CoverageSchema });
export const annotationCommands = {
  'annotation.read': { input: z.strictObject({ ...target, limit: z.number().int().min(0).max(500).default(100), cursor: CursorSchema.optional() }),
    output: z.strictObject({ ...target, fields: AnnotationFieldsSchema, history: z.array(history).max(500),
      nextCursor: CursorSchema.optional(), coverage: CoverageSchema, links: z.array(AssessmentLinkSchema.strict()) }) },
  'annotation.confirm': { input: z.strictObject({ ...target, field, annotationId: IdSchema }), output: recorded },
  'annotation.replace': { input: z.strictObject({ ...target, field, value: z.json(), annotationId: IdSchema }), output: recorded },
} as const;
const AuditId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/);
const WorkLevel = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const autonomyCommands = {
  'autonomy.policy.set': { input: z.strictObject({ courseId: AuditId, status: z.enum(['allowed', 'prohibited', 'owner-attested']).nullable() }), output: recorded },
  'autonomy.default.set': { input: z.strictObject({ courseId: AuditId, level: WorkLevel }), output: recorded },
  'autonomy.override.set': { input: z.strictObject({ assessmentId: AuditId, level: WorkLevel }), output: recorded },
  'autonomy.override.clear': { input: z.strictObject({ assessmentId: AuditId }), output: recorded },
} as const;
const Kind = z.enum(['quiz', 'ongoing', 'assignment', 'exam']);
/** Anonymous L0 read; kept apart from the owner writes above so it never needs the session. */
export const autonomyReads = {
  'autonomy.read': { input: z.strictObject({ courseId: AuditId }), output: z.strictObject({ courseId: AuditId,
    policy: z.enum(['allowed', 'prohibited', 'owner-attested']).nullable(), policyOrigin: z.enum(['owner', 'agent']).nullable(), cap: z.union([z.literal(0), z.literal(2)]),
    defaultLevel: WorkLevel, assessments: z.array(z.strictObject({ assessmentId: AuditId, kind: Kind.nullable(),
      applicable: z.boolean(), requiredLevel: z.union([z.literal(1), z.literal(2)]).nullable(), override: WorkLevel.nullable(),
      effectiveLevel: WorkLevel.nullable() })).max(500) }) },
} as const;
const planningRecorded = z.strictObject({ recorded: z.literal(true), id: IdSchema.optional() });
export const workCommands = {
  'estimate.owner.set': { input: planningInputs['estimate.owner.set'], output: planningRecorded },
  'time.record': { input: planningInputs['time.record'], output: planningRecorded },
} as const;
