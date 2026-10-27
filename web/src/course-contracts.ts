import { z } from 'zod';
import { AnnotationFieldsSchema, CitationInputSchema, CoverageSchema, CursorSchema, IdSchema, VerifiedCitationSchema } from '../../shared/protocol/contracts.js';
import { AnnotationSchema, AnnotationVerdictSchema, AssessmentLinkSchema } from '../../shared/domain/schemas.js';
import { planningInputs } from '../../shared/planning/contracts.js';

// Browser copies of the annotation and autonomy contracts: their server modules import Node built-ins.
// test/web/course-contracts.test.ts keeps them identical to src/protocol/{annotations,autonomy}.ts.
const target = { entity: z.enum(['assessment', 'course']), entityId: IdSchema };
const field = z.enum(['weight', 'kind', 'hurdleMin', 'isFinal', 'name', 'due', 'assessmentsComplete', 'aiPolicy']);
const recorded = z.strictObject({ recorded: z.literal(true) });
const history = z.strictObject({ ...AnnotationSchema.shape, citations: z.array(z.union([VerifiedCitationSchema, CitationInputSchema])),
  verdicts: z.array(AnnotationVerdictSchema.strict()), coverage: CoverageSchema });
const Policy = z.enum(['allowed', 'prohibited', 'owner-attested']);
const effectivePolicy = z.strictObject({ value: z.union([Policy, z.literal('unknown')]),
  origin: z.enum(['owner', 'agent', 'none']), level: z.enum(['assessment', 'course', 'none']) });
const policyFields = { policy: Policy.nullable(), policyOrigin: z.enum(['owner', 'agent']).nullable(),
  policyLevel: z.enum(['assessment', 'course']).nullable(), effectivePolicy };
// `annotation.read` reports the policy when it can resolve one; older servers may omit these keys.
const policyRead = { policy: Policy.nullable().optional(), policyOrigin: z.enum(['owner', 'agent']).nullable().optional(),
  policyLevel: z.enum(['assessment', 'course']).nullable().optional(), effectivePolicy: effectivePolicy.optional() };
const readOutput = z.strictObject({ ...target, fields: AnnotationFieldsSchema, history: z.array(history).max(500),
  nextCursor: CursorSchema.optional(), coverage: CoverageSchema, links: z.array(AssessmentLinkSchema.strict()) });
export const annotationCommands = {
  'annotation.read': { input: z.strictObject({ ...target, limit: z.number().int().min(0).max(500).default(100), cursor: CursorSchema.optional() }),
    output: readOutput.extend(policyRead) },
  'annotation.confirm': { input: z.strictObject({ ...target, field, annotationId: IdSchema }), output: recorded },
  'annotation.replace': { input: z.strictObject({ ...target, field, value: z.json(), annotationId: IdSchema }), output: recorded },
} as const;
const AuditId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/);
const WorkLevel = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const autonomyCommands = {
  'autonomy.policy.set': { input: z.strictObject({ courseId: AuditId, assessmentId: AuditId.optional(), status: Policy.nullable() }), output: recorded },
  'autonomy.default.set': { input: z.strictObject({ courseId: AuditId, level: WorkLevel }), output: recorded },
  'autonomy.override.set': { input: z.strictObject({ assessmentId: AuditId, level: WorkLevel }), output: recorded },
  'autonomy.override.clear': { input: z.strictObject({ assessmentId: AuditId }), output: recorded },
} as const;
const Kind = z.preprocess(value => value === 'ongoing' ? 'participation' : value,
  z.enum(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded']));
/** Anonymous L0 read; kept apart from the owner writes above so it never needs the session. */
export const autonomyReads = {
  'autonomy.read': { input: z.strictObject({ courseId: AuditId }), output: z.strictObject({ courseId: AuditId, ...policyFields,
    cap: z.union([z.literal(0), z.literal(2)]), defaultLevel: WorkLevel, assessments: z.array(z.strictObject({ assessmentId: AuditId,
      kind: Kind.nullable(), applicable: z.boolean(), requiredLevel: z.union([z.literal(1), z.literal(2)]).nullable(),
      override: WorkLevel.nullable(), effectiveLevel: WorkLevel.nullable(), ...policyFields })).max(500) }) },
} as const;
const planningRecorded = z.strictObject({ recorded: z.literal(true), id: IdSchema.optional() });
export const workCommands = {
  'estimate.owner.set': { input: planningInputs['estimate.owner.set'], output: planningRecorded },
  'time.record': { input: planningInputs['time.record'], output: planningRecorded },
} as const;
