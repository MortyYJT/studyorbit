import { z } from 'zod';

const httpUrl = z.string().url().refine(value => /^https?:\/\//i.test(value), 'URL must use HTTP or HTTPS');
const source = z.object({ platform: z.enum(['canvas', 'ed', 'handbook', 'user']), url: httpUrl.nullable(), evidence: z.string().nullable() }).strict();
const courseInfo = z.object({ id: z.string().min(1), code: z.string().min(1), name: z.string().min(1), term: z.string().nullable() }).strict();
const material = z.object({ name: z.string().min(1), url: httpUrl.nullable(), platform: z.enum(['canvas', 'ed']) }).strict();
const name = z.string().min(1);
const kind = z.enum(['quiz', 'assignment', 'test', 'presentation', 'participation', 'hurdle', 'other']);
const nature = z.enum(['regular', 'ungraded', 'bonus', 'alternative']);
const scoring = z.enum(['none', 'points', 'weighted']).describe('Parent aggregation rule; use none for children');
const weight = z.number().min(0).max(100).nullable().describe('Percentage of the course total, not raw points');
const rule = z.string().nullable().describe('Concise scoring or hurdle rule');
const assessmentFields = {
  id: z.string().min(1).max(500).describe('Stable assessment ID, preferably a platform ID'), name, kind, nature,
  parentId: z.string().min(1).nullable().describe('Top-level assessment ID, or null'), weight,
  score: z.number().min(0).nullable().describe('Actually earned points'), maxScore: z.number().min(0).nullable().describe('Maximum raw points or bonus cap'),
  due: z.string().nullable().describe('Confirmed assessment deadline, not submission or availability time'), status: z.enum(['not_started', 'in_progress', 'submitted', 'graded', 'unknown']),
  scoring, rule, sources: z.array(source),
};

/** A platform reference: Canvas assignment ID, Canvas assignment group ID, Ed lesson ID, or a component name of the institution's framework source (contract value `handbook`). */
const reference = z.object({ platform: z.enum(['canvas', 'canvas-group', 'ed', 'handbook']), id: z.string().min(1) }).strict();
const quote = z.string().nullable();

type Item = { id: string; parentId: string | null; score: number | null; maxScore: number | null };
/** Rules shared by v1 and v2: unique IDs, score not above maximum, existing acyclic parents, one parent level. */
function checkAssessments(assessments: Item[], ctx: z.RefinementCtx) {
  const items = new Map(assessments.map(item => [item.id, item]));
  if (items.size !== assessments.length) ctx.addIssue({ code: 'custom', message: 'assessment ids must be unique' });
  for (const [index, item] of assessments.entries()) {
    if (item.score !== null && item.maxScore !== null && item.score > item.maxScore) ctx.addIssue({ code: 'custom', path: ['assessments', index, 'score'], message: 'score exceeds maximum' });
    const visited = new Set([item.id]); let parent = item.parentId;
    while (parent !== null) {
      if (!items.has(parent) || visited.has(parent)) { ctx.addIssue({ code: 'custom', path: ['assessments', index, 'parentId'], message: 'parent missing or cyclic' }); break; }
      visited.add(parent); parent = items.get(parent)!.parentId;
    }
    if (item.parentId && items.get(item.parentId)?.parentId) ctx.addIssue({ code: 'custom', path: ['assessments', index, 'parentId'], message: 'only one parent level is supported' });
  }
}

/** Stored course document version 1 (written by syncs before contract v2). Also the model output until the sync moves to v2. */
export const CourseDocumentV1Schema = z.object({
  version: z.literal(1),
  course: courseInfo,
  assessments: z.array(z.object(assessmentFields).strict()),
  materials: z.array(material),
}).strict().superRefine((doc, ctx) => checkAssessments(doc.assessments, ctx));

const assessmentV2 = z.object({
  ...assessmentFields,
  refs: z.array(reference).describe('Platform references, de-duplicated'),
  weightQuote: quote.describe('Verified verbatim source of the weight, or null'),
  ruleQuote: quote.describe('Verified verbatim source of the rule, or null'),
  unsourced: z.array(z.enum(['weight', 'rule'])).describe('Fields cleared because no source was found'),
}).strict().superRefine((item, ctx) => {
  const refs = item.refs.map(ref => `${ref.platform}\u0000${ref.id}`);
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: 'custom', path: ['refs'], message: 'references must be unique' });
  if (new Set(item.unsourced).size !== item.unsourced.length) ctx.addIssue({ code: 'custom', path: ['unsourced'], message: 'unsourced fields must be unique' });
  for (const [field, quoteField] of [['weight', 'weightQuote'], ['rule', 'ruleQuote']] as const) {
    if (item.unsourced.includes(field) && (item[field] !== null || item[quoteField] !== null)) ctx.addIssue({ code: 'custom', path: [field], message: `an unsourced ${field} must be null with no quote` });
    if (item[field] === null && item[quoteField] !== null) ctx.addIssue({ code: 'custom', path: [quoteField], message: `a quote needs a ${field}` });
  }
});

/** Stored course document version 2: v1 fields plus references, verified quotes, unsourced fields and the legacy ID map. */
export const CourseDocumentV2Schema = z.object({
  version: z.literal(2),
  course: courseInfo,
  assessments: z.array(assessmentV2),
  materials: z.array(material),
  legacyIds: z.record(z.string().min(1), z.string().min(1)).describe('Earlier assessment ID -> current ID'),
}).strict().superRefine((doc, ctx) => checkAssessments(doc.assessments, ctx));

/** Any stored course document a reader accepts: version 1 or 2. Other versions are invalid. */
export const CourseDocumentSchema = z.discriminatedUnion('version', [CourseDocumentV1Schema, CourseDocumentV2Schema]);
export type CourseDocumentV1 = z.infer<typeof CourseDocumentV1Schema>;
export type CourseDocumentV2 = z.infer<typeof CourseDocumentV2Schema>;
export type CourseDocument = z.infer<typeof CourseDocumentSchema>;

/** One display shape for both versions; `version` keeps the stored version. */
export type DisplayDocument = Omit<CourseDocumentV2, 'version'> & { version: 1 | 2 };
export type DisplayAssessment = DisplayDocument['assessments'][number];

/**
 * Converts a stored document of either version (or an already converted one) into the display shape.
 * A v1 assessment gets empty `refs`, null quotes and empty `unsourced`; a v1 document gets empty `legacyIds`.
 * Returns new objects and never modifies the input.
 */
export function toDisplayDocument(doc: CourseDocument | DisplayDocument): DisplayDocument {
  return {
    version: doc.version, course: { ...doc.course }, materials: doc.materials.map(item => ({ ...item })),
    assessments: doc.assessments.map((item: CourseDocumentV1['assessments'][number] & Partial<DisplayAssessment>) => ({
      ...item, sources: item.sources.map(entry => ({ ...entry })), refs: (item.refs ?? []).map(ref => ({ ...ref })),
      weightQuote: item.weightQuote ?? null, ruleQuote: item.ruleQuote ?? null, unsourced: [...(item.unsourced ?? [])],
    })),
    legacyIds: { ...('legacyIds' in doc ? doc.legacyIds : {}) },
  };
}

/**
 * Model output version 2: the `document` inside `{ status, reason, document }`. The model returns references, grouping,
 * classification, weights, rules and their quotes only; IDs, dates, scores, statuses and sources are filled by code.
 */
export const CourseModelOutputSchema = z.object({
  version: z.literal(2),
  course: courseInfo,
  assessments: z.array(z.object({
    key: z.string().min(1).max(500).describe('Unique key within this output'),
    parentKey: z.string().min(1).nullable().describe('Key of the top-level parent item, or null'),
    refs: z.array(reference).describe('Collected platform IDs, or listed Handbook component names; empty only for a group with children'),
    name, kind, nature, scoring, weight,
    weightQuote: quote.describe('Exact text from the collected data that states the weight, or null'),
    rule,
    ruleQuote: quote.describe('Exact text from the collected data that states the rule, or null'),
  }).strict()),
  materials: z.array(material),
}).strict();
export type CourseModelOutput = z.infer<typeof CourseModelOutputSchema>;
