import { z } from 'zod';
import { SourceItemSchema, type Course, type SourceItem, type Assessment, type AssessmentLink, type Citation } from '../domain/schemas.js';
import { sourceIdentity, scopeHash } from './ed-adapter.js';
import { CANVAS_ORIGIN, ED_ORIGIN } from './ed-scope.js';
import { CanvasAssignmentSchema, CanvasGroupSchema, CanvasModuleSchema, CanvasSubmissionSchema, providerId } from './canvas-reader.js';
export const EdAttemptSchema = z.object({ id: providerId, title: z.string(), slides: z.array(z.object({ id: providerId })).max(300).optional(),
  due_at: z.iso.datetime({ offset: true }).nullable().optional(), effective_due_at: z.iso.datetime({ offset: true }).nullable().optional(),
  max_score: z.number().nonnegative().nullable().optional(), score: z.number().nonnegative().nullable().optional(), submitted: z.boolean().optional() }).passthrough();
export function source(provider: 'canvas' | 'ed', externalCourse: string, courseId: string, externalId: string, kind: SourceItem['kind'], title: string, text: string, at: string, url: string): SourceItem {
  return SourceItemSchema.parse({ id: sourceIdentity(provider, provider === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN, externalCourse, externalId),
    platform: provider, externalId, courseId, kind, title, text, url, fetchedAt: at, contentHash: scopeHash(text), removed: false });
}
export function normalizeCanvas(course: Course, data: { assignments: z.output<typeof CanvasAssignmentSchema>[]; groups: z.output<typeof CanvasGroupSchema>[]; submissions: z.output<typeof CanvasSubmissionSchema>[]; modules: z.output<typeof CanvasModuleSchema>[] }, at: string, existing: readonly Assessment[] = []): { sources: SourceItem[]; assessments: Assessment[]; links: AssessmentLink[]; citations: Citation[] } {
  const external = course.sources!.find(s => s.platform === 'canvas')!.externalId;
  const sources: SourceItem[] = []; const assessments: Assessment[] = []; const links: AssessmentLink[] = []; const citations: Citation[] = [];
  for (const group of data.groups) {
    const locator = `${CANVAS_ORIGIN}/api/v1/courses/${external}/assignment_groups/${group.id}#/group_weight`;
    const text = `name: ${group.name}${typeof group.group_weight === 'number' ? `\ngroup_weight: ${group.group_weight}\ncitation: ${locator}` : ''}`;
    const item = source('canvas', external, course.id, `group:${group.id}`, 'material', group.name, text, at, `${CANVAS_ORIGIN}/api/v1/courses/${external}/assignment_groups`);
    sources.push(item);
    const assessmentId = `assessment:${scopeHash(`${course.id}:canvas:${external}:group:${group.id}`)}`;
    if (typeof group.group_weight !== 'number' && !existing.some(a => a.id === assessmentId && a.origin === 'sync')) continue;
    assessments.push({ id: assessmentId, courseId: course.id, name: group.name, ...(typeof group.group_weight === 'number' ? { weight: group.group_weight } : {}), origin: 'sync', isFinal: false, status: 'not_started' });
    links.push({ assessmentId, sourceItemId: item.id, origin: 'sync', at });
    if (typeof group.group_weight === 'number') citations.push({ sourceItemId: item.id, quote: `group_weight: ${group.group_weight}`, locator });
    for (const assignment of data.assignments.filter(a => a.assignment_group_id === group.id)) links.push({ assessmentId,
      sourceItemId: sourceIdentity('canvas', CANVAS_ORIGIN, external, `assignment:${assignment.id}`), origin: 'sync', at });
  }
  for (const assignment of data.assignments) {
    const submission = data.submissions.find(s => s.assignment_id === assignment.id);
    const facts: NonNullable<SourceItem['facts']> = {};
    if (assignment.due_at) facts.due = assignment.due_at;
    if (typeof assignment.points_possible === 'number') facts.pointsPossible = assignment.points_possible;
    if (typeof submission?.score === 'number') facts.pointsEarned = submission.score;
    if (submission) facts.submitted = !!submission.submitted_at || ['submitted', 'graded', 'pending_review'].includes(submission.workflow_state);
    const text = [`name: ${assignment.name}`, assignment.description ?? '', ...Object.entries(facts).map(([k, v]) => `${k}: ${v}`)].join('\n');
    sources.push({ ...source('canvas', external, course.id, `assignment:${assignment.id}`, 'assignment', assignment.name, text, at,
      `${CANVAS_ORIGIN}/courses/${external}/assignments/${assignment.id}`), facts });
  }
  for (const module of data.modules) sources.push(source('canvas', external, course.id, `module:${module.id}`, 'material', module.name, `name: ${module.name}`, at,
    `${CANVAS_ORIGIN}/courses/${external}/modules/${module.id}`));
  return { sources, assessments, links, citations };
}
export function normalizeEdAttempt(courseId: string, externalId: string, input: unknown, at: string): SourceItem {
  const lesson = EdAttemptSchema.parse(input);
  const facts: NonNullable<SourceItem['facts']> = {};
  const due = Object.hasOwn(lesson, 'effective_due_at') ? lesson.effective_due_at : lesson.due_at;
  if (due) facts.due = due;
  if (typeof lesson.max_score === 'number') facts.pointsPossible = lesson.max_score;
  if (typeof lesson.score === 'number') facts.pointsEarned = lesson.score;
  if (lesson.submitted !== undefined) facts.submitted = lesson.submitted;
  return { ...source('ed', externalId, courseId, `attempt:${lesson.id}`, 'assignment', lesson.title,
    [`title: ${lesson.title}`, ...Object.entries(facts).map(([k, v]) => `${k}: ${v}`)].join('\n'), at, `${ED_ORIGIN}/api/lessons/${lesson.id}`), facts };
}
