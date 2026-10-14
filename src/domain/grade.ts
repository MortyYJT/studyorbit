import { z } from 'zod';
import type { Assessment, Course } from './schemas.js';

export const GradeBandSchema = z.enum(['H1', 'H2A', 'H2B', 'H3', 'P']);
export type GradeBand = z.infer<typeof GradeBandSchema>;
export const GRADE_BANDS = { H1: 80, H2A: 75, H2B: 70, H3: 65, P: 50 } as const satisfies Record<GradeBand, number>;

export const GradeNeedSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('score'), value: z.number(), setByHurdle: z.boolean() }),
  z.object({ status: z.literal('unreachable') }),
  z.object({ status: z.literal('secured') }),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['weights_unknown', 'nothing_graded', 'no_final', 'final_graded']) }),
]);
export type GradeNeed = z.infer<typeof GradeNeedSchema>;

export const GradeProjectionSchema = z.object({
  gradedWeight: z.number(),
  earned: z.number(),
  currentAverage: z.number().nullable(),
  need: GradeNeedSchema,
});
export type GradeProjection = z.infer<typeof GradeProjectionSchema>;

export function projectGrade(course: Course, assessments: readonly Assessment[], band: GradeBand): GradeProjection {
  const graded = assessments.filter((a) => a.score !== undefined && a.weight !== undefined);
  const gradedWeight = graded.reduce((sum, a) => sum + (a.weight ?? 0), 0);
  const earned = graded.reduce((sum, a) => sum + ((a.weight ?? 0) * (a.score ?? 0)) / 100, 0);
  const currentAverage = gradedWeight > 0 ? (earned / gradedWeight) * 100 : null;
  const final = assessments.find((a) => a.isFinal);
  const ungradedOtherWeight = assessments
    .filter((a) => !a.isFinal && a.score === undefined)
    .reduce((sum, a) => sum + (a.weight ?? 0), 0);
  const need: GradeNeed = assessments.some(a => a.weight === undefined)
    ? { status: 'unavailable', reason: 'weights_unknown' }
    : decideNeed(currentAverage, final, earned, ungradedOtherWeight, GRADE_BANDS[band]);
  return { gradedWeight, earned, currentAverage, need };
}

/** Decides the final-exam need, in the evaluation order of specs/domain-model "Grade projection". */
function decideNeed(
  currentAverage: number | null,
  final: Assessment | undefined,
  earned: number,
  ungradedOtherWeight: number,
  target: number,
): GradeNeed {
  if (currentAverage === null) return { status: 'unavailable', reason: 'nothing_graded' };
  if (final === undefined) return { status: 'unavailable', reason: 'no_final' };
  if (final.score !== undefined) return { status: 'unavailable', reason: 'final_graded' };
  // Ungraded non-final items are assumed to score the current average.
  const projected = earned + (ungradedOtherWeight * currentAverage) / 100;
  const raw = ((target - projected) * 100) / (final.weight ?? 0);
  if (raw > 100) return { status: 'unreachable' };
  // A hurdle still applies when the target is already secured.
  if (final.hurdleMin !== undefined) {
    const value = Math.max(raw, final.hurdleMin);
    return { status: 'score', value, setByHurdle: value > raw };
  }
  if (raw <= 0) return { status: 'secured' };
  return { status: 'score', value: raw, setByHurdle: false };
}
