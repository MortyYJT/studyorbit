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
/** Why an assessment adds nothing to the course total. */
export type ExclusionReason = 'bonus' | 'ungraded' | 'alternative' | 'zero-weight' | 'no-weight' | 'no-mark' | 'incomplete-group';
export type GradeBreakdown = {
  /** Leaves first (assessment order), then completed groups (parent order); `key` is the group's source key, or `group:<index>`. */
  counted: { key: string; group: boolean; weight: number; earned: number }[];
  /** Assessments that add nothing, in assessment order. Non-excluded children of a counted group are in neither list. */
  excluded: { key: string; reason: ExclusionReason }[];
};
const hasMark = (item: GradingItem) => item.score !== undefined && item.outOf !== undefined && item.outOf > 0 && item.score >= 0 && item.score <= item.outOf;
const isUngraded = (item: GradingItem) => item.ungraded === true || item.kind === 'ungraded';
/** Reason a child is left out of its group's own aggregation, if any (see parentGrade). */
function childSkip(item: GradingItem): ExclusionReason | undefined {
  if (item.bonus) return 'bonus';
  if (isUngraded(item)) return 'ungraded';
  if (item.caution) return 'alternative';
  if (item.sourceZero) return 'zero-weight';
  return undefined;
}
/** Every counted item and group with its weight and earned points, and every excluded item with a reason. */
export function gradeBreakdown(assessments: GradingItem[], parents: GradingGroup[]): GradeBreakdown {
  const completed = parents.flatMap((parent, index) => { const grade = parentGrade(parent); return grade ? [{ parent, grade, index }] : []; });
  const counted = new Set(completed.flatMap(({ parent }) => [...parent.children.map(child => child.key), ...(parent.sourceKey ? [parent.sourceKey] : [])]));
  const groupFailure = (parent: GradingGroup): ExclusionReason => parent.weight === undefined ? 'no-weight' : parent.weight <= 0 ? 'zero-weight' : 'incomplete-group';
  const leaves: GradeBreakdown['counted'] = [];
  const excluded: GradeBreakdown['excluded'] = [];
  for (const item of assessments) {
    if (counted.has(item.key)) {
      const skip = completed.some(({ parent }) => parent.sourceKey === item.key) ? undefined : childSkip(item);
      if (skip) excluded.push({ key: item.key, reason: skip });
      continue;
    }
    const skip = childSkip(item);
    if (skip) { excluded.push({ key: item.key, reason: skip }); continue; }
    const ownGroup = parents.find(parent => parent.sourceKey === item.key);
    const group = parents.find(parent => parent.children.some(child => child.key === item.key));
    if (item.weightValue === undefined) {
      const failed = ownGroup ?? group;
      excluded.push({ key: item.key, reason: failed ? groupFailure(failed) : 'no-weight' });
      continue;
    }
    if (!hasMark(item)) { excluded.push({ key: item.key, reason: ownGroup ? groupFailure(ownGroup) : 'no-mark' }); continue; }
    leaves.push({ key: item.key, group: false, weight: item.weightValue, earned: item.weightValue * item.score! / item.outOf! });
  }
  const groups = completed.map(({ parent, grade, index }) => ({ key: parent.sourceKey ?? `group:${index}`, group: true, weight: parent.weight!, earned: grade.earned }));
  return { counted: [...leaves, ...groups], excluded };
}
export function calculateGrades(assessments: GradingItem[], parents: GradingGroup[]) {
  const { counted } = gradeBreakdown(assessments, parents);
  // Same summation order as before the breakdown existed: leaves, then groups.
  const leaves = counted.filter(entry => !entry.group), groups = counted.filter(entry => entry.group);
  const weight = leaves.reduce((sum, entry) => sum + entry.weight, 0) + groups.reduce((sum, entry) => sum + entry.weight, 0);
  const earned = leaves.reduce((sum, entry) => sum + entry.earned, 0) + groups.reduce((sum, entry) => sum + entry.earned, 0);
  return { weight, earned, average: weight ? earned / weight * 100 : undefined };
}
/** UniMelb grade bands, as a percentage of the course total. */
export const bandTargets = { H1: 80, H2A: 75, H2B: 70, H3: 65, P: 50 } as const;
export type Band = keyof typeof bandTargets;
export type FinalNeeded = { status: 'secured' } | { status: 'unreachable' } | { status: 'reachable'; percent: number };
/** Average still needed across every weight without a mark (100 − graded), so unidentified weight counts as remaining. */
export function finalNeeded(grades: { earned: number; weight: number }, target: number): FinalNeeded {
  // Tolerance: weighted sums can land a hair under the target that was in fact reached.
  if (grades.earned >= target - 1e-9) return { status: 'secured' };
  const remaining = 100 - grades.weight;
  if (remaining <= 0) return { status: 'unreachable' };
  const percent = (target - grades.earned) / remaining * 100;
  return percent > 100 ? { status: 'unreachable' } : { status: 'reachable', percent };
}
