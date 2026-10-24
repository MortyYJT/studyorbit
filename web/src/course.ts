import { z } from 'zod';
import { projectGrade, type GradeBand, type GradeProjection } from '../../src/domain/grade.js';
import { AssessmentSchema, type Assessment, type Course } from '../../src/domain/schemas.js';
import type { AnnotationFieldsSchema } from '../../src/protocol/contracts.js';
import type { planOutput } from '../../src/planning/contracts.js';
import type { autonomyReads } from './course-contracts.js';
import { zonedIso } from './week.js';

type Graded = Pick<Assessment, 'id' | 'weight' | 'score'>;
export type SegmentStyle = 'earned' | 'lost' | 'ungraded' | 'unknown';
export interface Segment { assessmentId: string; style: SegmentStyle; start: number; end: number }
/** Degrees given to each assessment whose weight is unknown; known weights share the rest. */
export const UNKNOWN_SPAN = 8;

/** Score ring (#141): one segment per assessment sized by weight, in degrees clockwise from the top. */
export function ringSegments(items: readonly Graded[]): Segment[] {
  const unknown = items.filter(item => item.weight === undefined).length;
  const known = items.reduce((sum, item) => sum + (item.weight ?? 0), 0);
  const scale = (360 - unknown * UNKNOWN_SPAN) / Math.max(known, 100);
  let at = 0;
  return items.flatMap((item): Segment[] => {
    const start = at;
    const span = item.weight === undefined ? UNKNOWN_SPAN : item.weight * scale;
    at += span;
    if (item.weight === undefined) return [{ assessmentId: item.id, style: 'unknown' as const, start, end: at }];
    if (item.score === undefined) return [{ assessmentId: item.id, style: 'ungraded' as const, start, end: at }];
    const middle = start + span * item.score / 100;
    return ([{ assessmentId: item.id, style: 'earned' as const, start, end: middle }, { assessmentId: item.id, style: 'lost' as const, start: middle, end: at }])
      .filter(segment => segment.end > segment.start);
  });
}
/** SVG arc on the 170-unit ring canvas, angles in degrees clockwise from the top. */
export function arcPath(radius: number, start: number, end: number, centre = 85): string {
  const point = (degrees: number) => {
    const radians = (degrees - 90) * Math.PI / 180;
    return `${(centre + radius * Math.cos(radians)).toFixed(2)} ${(centre + radius * Math.sin(radians)).toFixed(2)}`;
  };
  return `M${point(start)} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${point(end)}`;
}
/** Grade figures come from the shared domain projection; the frontend never re-derives them. */
export function courseFigures(course: Course, items: readonly Assessment[], band: GradeBand): GradeProjection {
  return projectGrade(course, items, band);
}

type Grouped = Pick<Assessment, 'id' | 'weight' | 'score' | 'group' | 'readState'>;
/** `earned` is undefined when a scored item's weight is unknown, as the ring then cannot size it either. */
export interface AssessmentGroup<T> { key?: string; name?: string; weight?: number; earned?: number; items: T[] }
/** Groups by grading component in list order; assessments without a component come last in one unnamed group. */
export function assessmentGroups<T extends Grouped>(items: readonly T[]): AssessmentGroup<T>[] {
  const groups = new Map<string | undefined, AssessmentGroup<T>>();
  for (const item of items) {
    const key = item.group?.key;
    const group = groups.get(key) ?? { ...(item.group ? { key: item.group.key, name: item.group.name, ...(item.group.weight !== undefined ? { weight: item.group.weight } : {}) } : {}), earned: 0, items: [] };
    // A final or hurdled component is one row: its effective weight (an owner override included) is the component's weight.
    if (item.group?.role === 'component') { if (item.weight === undefined) delete group.weight; else group.weight = item.weight; }
    group.items.push(item);
    // Earned share (#171): graded items contribute weight × score; the agent never fills this in.
    if (item.score !== undefined) group.earned = item.weight === undefined || group.earned === undefined ? undefined : group.earned + item.weight * item.score / 100;
    groups.set(key, group);
  }
  const loose = groups.get(undefined);
  return [...[...groups.values()].filter(group => group !== loose), ...loose ? [loose] : []];
}
/** The unpublished share of a component, marked by import. */
export function isRemainder(item: Pick<Assessment, 'id'> & { group?: Assessment['group'] }): boolean {
  return item.group?.role === 'remainder';
}
export type ValueLabel = { kind: 'value' } | { kind: 'derived' } | { kind: 'unknown'; checkedAt?: string } | { kind: 'none' };
/**
 * A shown value, an evenly split weight (only while no owner or agent value replaced it), unknown with its check time,
 * or none ("—") for a not-applicable value and a missing due date nobody read (exams, older rows).
 */
export function valueLabel(item: Pick<Assessment, 'weight' | 'due' | 'readState'> & { fields?: Record<string, Field> }, field: 'weight' | 'due'): ValueLabel {
  const read = item.readState?.[field];
  if (item[field] === undefined && (read?.state === 'not_applicable' || field === 'due' && !read)) return { kind: 'none' };
  if (item[field] === undefined) return read?.state === 'unknown' && read.checkedAt ? { kind: 'unknown', checkedAt: read.checkedAt } : { kind: 'unknown' };
  const origin = item.fields?.[field]?.origin ?? 'sync';
  return field === 'weight' && read?.state === 'derived' && origin === 'sync' ? { kind: 'derived' } : { kind: 'value' };
}
export interface PolicyView { effective?: Policy; origin?: 'owner' | 'agent'; read?: Policy; quote?: string }
/** Effective policy and origin from `autonomy.read`; the agent-read value and quote from the Course (#180). */
export function policyView(course: Pick<Course, 'id' | 'aiPolicy' | 'readState'>, autonomy: Pick<AutonomyRead, 'policy' | 'policyOrigin'> | undefined): PolicyView {
  const quote = course.readState?.aiPolicy?.quote;
  return { ...(autonomy?.policy ? { effective: autonomy.policy } : {}), ...(autonomy?.policy && autonomy.policyOrigin ? { origin: autonomy.policyOrigin } : {}),
    ...(course.aiPolicy ? { read: course.aiPolicy } : {}), ...(course.aiPolicy && quote ? { quote } : {}) };
}

export const presetIds ={ complete: 'complete-assessment', explain: 'explain-assessment', tutor: 'tutor-revision', wrong: 'wrong-answers-only' } as const;
export type Field = z.output<typeof AnnotationFieldsSchema>[string];
export type Origin = 'platform' | 'agent' | 'owner';
export function originOf(field?: Field): Origin | undefined {
  return field?.origin === 'sync' ? 'platform' : field?.origin ?? undefined;
}
export type WorkLevel = 0 | 1 | 2;
export type Policy = 'allowed' | 'prohibited' | 'owner-attested';
export type AutonomyRead = z.output<typeof autonomyReads['autonomy.read']['output']>;
export type LevelView = { kind: 'none' } | { kind: 'locked' } | { kind: 'unknown' } | { kind: 'level'; level: WorkLevel; source: 'override' | 'default' };
/** Levels come only from `autonomy.read`; anything it does not cover stays unknown. */
export function levelView(assessment: { id: string; kind?: string }, autonomy: AutonomyRead | undefined): LevelView {
  const entry = autonomy?.assessments.find(row => row.assessmentId === assessment.id);
  if (assessment.kind === 'exam' || entry?.kind === 'exam') return { kind: 'none' };
  if (autonomy?.policy === 'prohibited') return { kind: 'locked' };
  if (!entry || entry.effectiveLevel === null) return { kind: 'unknown' };
  return { kind: 'level', level: entry.effectiveLevel, source: entry.override === null ? 'default' : 'override' };
}
/** The platform's submission state wins over a stale not-started or in-progress status. */
export function displayStatus(item: { status: Assessment['status']; platform?: { linked: boolean; submitted: boolean; removed: boolean } }): Assessment['status'] {
  return item.platform?.submitted && (item.status === 'not_started' || item.status === 'in_progress') ? 'submitted' : item.status;
}
/** One owner verdict per agent annotation: repeated verdicts would inflate annotation accuracy. */
export function canJudge(field?: Field): boolean {
  return field?.origin === 'agent' && field.annotationId !== undefined && field.verdicts.length === 0;
}
const sourceOrigins = ['https://canvas.lms.unimelb.edu.au', 'https://edstem.org'];
/** Stored source URLs become links only on the provider origins over https. */
export function sourceLink(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && sourceOrigins.includes(parsed.origin) ? parsed.href : undefined; }
  catch { return undefined; }
}
/** Exams get no agent entry (#146); completing work on a prohibited course is never offered. */
export function agentEntries(assessment: { kind?: string }, policy: Policy | undefined) {
  const exam = assessment.kind === 'exam';
  return { complete: !exam && policy !== 'prohibited', explain: !exam };
}
export type EditableField = 'weight' | 'kind' | 'hurdleMin' | 'isFinal' | 'name' | 'due';
/** `due` is a datetime-local wall-clock time in the planning time zone (the zone dates are shown in). */
export function ownerValue(field: EditableField, raw: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): unknown {
  const value = raw.trim();
  if (!value) throw new Error('Value required');
  if (field === 'weight' || field === 'hurdleMin') return AssessmentSchema.shape.weight.unwrap().parse(Number(value));
  if (field === 'kind') return AssessmentSchema.shape.kind.unwrap().parse(value);
  if (field === 'isFinal') return z.enum(['true', 'false']).parse(value) === 'true';
  if (field === 'due') {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
    if (!match) throw new Error('Invalid date');
    return AssessmentSchema.shape.due.unwrap().parse(zonedIso(match[1]!, match[2]!, timeZone));
  }
  return value;
}
export function minutesFrom(raw: string): number {
  return z.number().int().positive().safe().parse(Number(raw.trim() || Number.NaN));
}
type PlanPage = z.output<typeof planOutput>;
export type Work = PlanPage['work'][number];
/** Concatenates paged work rows and appends long-text continuations at their UTF-16 offsets. */
export function mergePlanWork(pages: readonly PlanPage[]): Work[] {
  const work = pages.flatMap(page => page.work.map(item => ({ ...item, ...(item.agentEstimate ? { agentEstimate: { ...item.agentEstimate } } : {}) })));
  for (const part of pages.flatMap(page => page.textContinuations ?? []).filter(part => part.collection === 'work')) {
    const item = work.find(row => row.workId === part.workId);
    if (!item) continue;
    if (part.field === 'title') item.title = item.title.slice(0, part.offset) + part.text;
    else if (item.agentEstimate) item.agentEstimate.reason = (item.agentEstimate.reason ?? '').slice(0, part.offset) + part.text;
  }
  return work;
}
