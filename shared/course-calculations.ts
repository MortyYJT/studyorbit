/** Deterministic grade calculation: all relationships and rules come from the document. */
export type GradingItem = { key: string; weightValue?: number; score?: number; outOf?: number; bonus?: boolean; ungraded?: boolean; caution: boolean; sourceZero: boolean; kind: string };
export type GradingGroup = { weight?: number; score?: number; outOf?: number; children: GradingItem[]; scoringRule: string; sourceKey?: string };
export type GradeResult = { score: number; outOf: number; earned: number };
export function parentGrade(parent: GradingGroup): GradeResult | undefined {
  if (parent.weight === undefined || parent.weight <= 0) return undefined;
  if (parent.score !== undefined && parent.outOf !== undefined && parent.outOf > 0 && parent.score >= 0 && parent.score <= parent.outOf) return { score: parent.score, outOf: parent.outOf, earned: parent.weight * parent.score / parent.outOf };
  if (parent.scoringRule !== 'points' && parent.scoringRule !== 'weighted') return undefined;
  const items = parent.children.filter(item => !item.bonus && !item.ungraded && !item.sourceZero && item.kind !== 'ungraded' && !item.caution);
  if (!items.length || items.some(item => item.score === undefined || item.outOf === undefined || item.outOf <= 0 || item.score < 0 || item.score > item.outOf)) return undefined;
  const score = items.reduce((sum, item) => sum + item.score!, 0);
  const outOf = items.reduce((sum, item) => sum + item.outOf!, 0);
  if (parent.scoringRule === 'weighted') {
    if (items.some(item => item.weightValue === undefined) || Math.abs(items.reduce((sum, item) => sum + item.weightValue!, 0) - parent.weight) > 0.001) return undefined;
    return { score, outOf, earned: items.reduce((sum, item) => sum + item.weightValue! * item.score! / item.outOf!, 0) };
  }
  return { score, outOf, earned: parent.weight * score / outOf };
}
export function calculateGrades(assessments: GradingItem[], parents: GradingGroup[]) {
  const completed = parents.flatMap(parent => { const grade = parentGrade(parent); return grade ? [{ parent, grade }] : []; });
  const counted = new Set(completed.flatMap(({ parent }) => [...parent.children.map(child => child.key), ...(parent.sourceKey ? [parent.sourceKey] : [])]));
  const graded = assessments.filter(item => !item.bonus && !item.ungraded && !counted.has(item.key) && item.weightValue !== undefined && item.score !== undefined && item.outOf !== undefined && item.outOf > 0 && item.score >= 0 && item.score <= item.outOf && !item.caution && !item.sourceZero && item.kind !== 'ungraded');
  const weight = graded.reduce((sum, item) => sum + item.weightValue!, 0) + completed.reduce((sum, item) => sum + item.parent.weight!, 0);
  const earned = graded.reduce((sum, item) => sum + item.weightValue! * item.score! / item.outOf!, 0) + completed.reduce((sum, item) => sum + item.grade.earned, 0);
  return { weight, earned, average: weight ? earned / weight * 100 : undefined };
}
/** UniMelb grade bands, as a percentage of the course total. */
export const bandTargets = { H1: 80, H2A: 75, H2B: 70, H3: 65, P: 50 } as const;
export type Band = keyof typeof bandTargets;
export type FinalNeeded = { status: 'secured' } | { status: 'unreachable' } | { status: 'reachable'; percent: number };
/** Average still needed across every weight without a mark (100 − graded), so unidentified weight counts as remaining. */
export function finalNeeded(grades: { earned: number; weight: number }, target: number): FinalNeeded {
  if (grades.earned >= target) return { status: 'secured' };
  const remaining = 100 - grades.weight;
  if (remaining <= 0) return { status: 'unreachable' };
  const percent = (target - grades.earned) / remaining * 100;
  return percent > 100 ? { status: 'unreachable' } : { status: 'reachable', percent };
}
