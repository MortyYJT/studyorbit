import { z } from 'zod';

const httpUrl = z.string().url().refine(value => /^https?:\/\//i.test(value), 'URL must use HTTP or HTTPS');
const source = z.object({ platform: z.enum(['canvas', 'ed', 'handbook', 'user']), url: httpUrl.nullable(), evidence: z.string().nullable() }).strict();
const assessment = z.object({
  id: z.string().min(1).max(500).describe('Stable assessment ID, preferably a platform ID'), name: z.string().min(1),
  kind: z.enum(['quiz', 'assignment', 'test', 'presentation', 'participation', 'hurdle', 'other']),
  nature: z.enum(['regular', 'ungraded', 'bonus', 'alternative']),
  parentId: z.string().min(1).nullable().describe('Top-level assessment ID, or null'), weight: z.number().min(0).max(100).nullable().describe('Percentage of the course total, not raw points'),
  score: z.number().min(0).nullable().describe('Actually earned points'), maxScore: z.number().min(0).nullable().describe('Maximum raw points or bonus cap'),
  due: z.string().nullable().describe('Confirmed assessment deadline, not submission or availability time'), status: z.enum(['not_started', 'in_progress', 'submitted', 'graded', 'unknown']),
  scoring: z.enum(['none', 'points', 'weighted']).describe('Parent aggregation rule; use none for children'), rule: z.string().nullable().describe('Concise scoring or hurdle rule'), sources: z.array(source),
}).strict();
export const CourseDocumentSchema = z.object({
  version: z.literal(1),
  course: z.object({ id: z.string().min(1), code: z.string().min(1), name: z.string().min(1), term: z.string().nullable() }).strict(),
  assessments: z.array(assessment),
  materials: z.array(z.object({ name: z.string().min(1), url: httpUrl.nullable(), platform: z.enum(['canvas', 'ed']) }).strict()),
}).strict().superRefine((doc, ctx) => {
  const items = new Map(doc.assessments.map(item => [item.id, item]));
  if (items.size !== doc.assessments.length) ctx.addIssue({ code: 'custom', message: 'assessment ids must be unique' });
  for (const [index, item] of doc.assessments.entries()) {
    if (item.score !== null && item.maxScore !== null && item.score > item.maxScore) ctx.addIssue({ code: 'custom', path: ['assessments', index, 'score'], message: 'score exceeds maximum' });
    const visited = new Set([item.id]); let parent = item.parentId;
    while (parent !== null) {
      if (!items.has(parent) || visited.has(parent)) { ctx.addIssue({ code: 'custom', path: ['assessments', index, 'parentId'], message: 'parent missing or cyclic' }); break; }
      visited.add(parent); parent = items.get(parent)!.parentId;
    }
    if (item.parentId && items.get(item.parentId)?.parentId) ctx.addIssue({ code: 'custom', path: ['assessments', index, 'parentId'], message: 'only one parent level is supported' });
  }
});
export type CourseDocument = z.infer<typeof CourseDocumentSchema>;
