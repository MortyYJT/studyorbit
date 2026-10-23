import { projectGrade, type GradeBand, type GradeProjection } from '../../src/domain/grade.js';
import type { Assessment, Course } from '../../src/domain/schemas.js';

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
  return items.flatMap(item => {
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
