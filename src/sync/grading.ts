import type { GroupsStage } from './canvas-api.js';
import type { SkeletonStage } from './handbook.js';
import type { ItemsClassifyInput, QuizzesReadInput } from '../protocol/sync.js';

/** One category of the grading rule; `unknown` is a graded item the classifier did not name. */
export type GradingCategory = 'exam' | 'quiz' | 'assignment' | 'presentation' | 'participation' | 'ungraded' | 'unknown';

export interface ResolvedChoices {
  /** Component key to the owner's choice; absent means the conflict is unresolved. */
  weight?: Record<string, 'skeleton' | 'canvas'>;
  /** Canvas assignment id to an assigned component key or `dismissed`. */
  unmatched?: Record<string, string>;
}

/** Both maps present, as `check.resolve` and `reconcileConflicts` return them. */
export interface CompleteResolvedChoices {
  weight: Record<string, 'skeleton' | 'canvas'>;
  unmatched: Record<string, string>;
}

export interface GradedItem {
  id: string;
  name: string;
  category: GradingCategory;
  graded: boolean;
  componentKey?: string;
  groupWeight?: number;
  effectiveComponentWeight?: number;
  hurdle?: string;
}

export interface WeightConflict {
  field: 'weight';
  componentKey: string;
  skeletonValue: number;
  canvasValue: number;
}

export interface UnmatchedConflict {
  field: 'unmatched';
  canvasAssignmentId: string;
  canvasValue: { id: string; name: string; due: string | null };
}

export type GradingConflict = WeightConflict | UnmatchedConflict;

export interface GradeInput {
  courseCode: string;
  groups?: GroupsStage;
  skeleton?: SkeletonStage;
  classification?: ItemsClassifyInput;
  /** The quiz flags the classifier saw; weights still decide, so this does not override the grading rule. */
  quizzes?: QuizzesReadInput;
  resolved?: ResolvedChoices;
}

export interface GradeResult {
  items: GradedItem[];
  conflicts: GradingConflict[];
}

/** The component-key pattern from `ComponentFieldsSchema`; the same shape `check.resolve` accepts. */
export const COMPONENT_KEY_PATTERN = /^[A-Z]{4}\d{5}:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lower-case words joined by `-`, as required by the course document's component key. */
export function componentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The skeleton component name as `<courseCode>:<slug>`; the code comes from the course, not the Handbook. */
export function componentKeyFor(courseCode: string, name: string): string | undefined {
  const slug = componentSlug(name);
  return slug ? `${courseCode}:${slug}` : undefined;
}

/** Match names case- and punctuation-insensitively, so "Written Assignments" reads as one component. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A weight the classifier copied from the compact list, such as `(weight 30)`, `(30%)` or `30%`. */
const WEIGHT_SUFFIX = /\s*(?:\(\s*weight\s+\d+(?:\.\d+)?\s*\)|\(\s*\d+(?:\.\d+)?\s*%\s*\)|\d+(?:\.\d+)?\s*%)\s*$/i;

/** The classifier's component name without a trailing weight, normalized for comparison. */
function normalizeComponentName(value: string): string {
  return normalizeName(value.replace(WEIGHT_SUFFIX, ''));
}

interface Component {
  key: string;
  name: string;
  weight?: number;
  hurdle?: string;
}

/** Exact normalized name first; otherwise the one skeleton name that is a word-boundary prefix. */
function matchComponent(name: string | undefined, byName: ReadonlyMap<string, Component>): Component | undefined {
  if (!name) return undefined;
  const normalized = normalizeComponentName(name);
  if (!normalized) return undefined;
  const exact = byName.get(normalized);
  if (exact) return exact;
  const candidates = [...byName.entries()].filter(([candidate]) => normalized.startsWith(`${candidate} `));
  return candidates.length === 1 ? candidates[0]![1] : undefined;
}

function skeletonComponents(courseCode: string, skeleton: SkeletonStage | undefined): Component[] {
  return (skeleton?.components ?? []).flatMap(component => {
    const key = componentKeyFor(courseCode, component.name);
    return key ? [{ key, name: component.name, ...(component.weight !== undefined ? { weight: component.weight } : {}),
      ...(component.hurdle ? { hurdle: component.hurdle } : {}) }] : [];
  });
}

/**
 * Apply the grading rule (layered-sync D7, task 6.1) to Canvas groups, the Handbook skeleton and the classifier's
 * six categories. Pure: no store access, so the pipeline can grade before it imports a course document.
 *
 * An item counts when its Canvas group weight is above 0, when its classified component has weight above 0, or
 * when that component carries a hurdle. A weight disagreement opens one `weight` conflict per component; a graded
 * item with no component opens `unmatched`. Everything else is `ungraded` whatever the classifier said.
 */
export function gradeItems(input: GradeInput): GradeResult {
  const components = skeletonComponents(input.courseCode, input.skeleton);
  const byName = new Map(components.map(component => [normalizeName(component.name), component]));
  const byKey = new Map(components.map(component => [component.key, component]));
  const assignmentIds = new Set((input.groups?.groups ?? []).flatMap(group => group.assignments.map(item => item.id)));
  const groupNameCounts = new Map<string, number>();
  for (const group of input.groups?.groups ?? []) {
    for (const assignment of group.assignments) {
      const name = normalizeName(assignment.name);
      groupNameCounts.set(name, (groupNameCounts.get(name) ?? 0) + 1);
    }
  }
  const classified = new Map((input.classification?.items ?? []).map(item => [item.id, item]));
  // A quiz page can name the same item with a quiz id, while the Canvas groups page names its assignment id;
  // map such an id through the quiz name only when that name identifies one quiz and one groups item.
  const quizNames = new Map<string, string>();
  const quizNameCounts = new Map<string, number>();
  for (const quiz of input.quizzes?.quizzes ?? []) {
    const name = normalizeName(quiz.name);
    quizNames.set(quiz.id, name);
    quizNameCounts.set(name, (quizNameCounts.get(name) ?? 0) + 1);
  }
  const classifiedByQuizName = new Map<string, ItemsClassifyInput['items'][number]>();
  for (const item of input.classification?.items ?? []) {
    if (assignmentIds.has(item.id)) continue;
    const name = quizNames.get(item.id);
    if (name && quizNameCounts.get(name) === 1 && groupNameCounts.get(name) === 1
      && !classifiedByQuizName.has(name)) {
      classifiedByQuizName.set(name, item);
    }
  }
  const items: GradedItem[] = [];
  const weightConflicts = new Map<string, WeightConflict>();
  const unmatched: UnmatchedConflict[] = [];

  for (const group of input.groups?.groups ?? []) {
    // An unknown Canvas weight is not "above 0"; the skeleton side can still make the item graded.
    const groupWeight = group.weight.value;
    const groupGraded = groupWeight !== null && groupWeight > 0;
    for (const assignment of group.assignments) {
      const classification = classified.get(assignment.id) ?? classifiedByQuizName.get(normalizeName(assignment.name));
      let component = matchComponent(classification?.component, byName);
      const resolvedComponent = input.resolved?.unmatched?.[assignment.id];
      const dismissed = resolvedComponent === 'dismissed';
      if (resolvedComponent !== undefined && !dismissed) {
        component = byKey.get(resolvedComponent);
      }
      const componentKey = resolvedComponent !== undefined && !dismissed ? resolvedComponent : component?.key;
      const componentGraded = component?.weight !== undefined && component.weight > 0;
      const hurdle = component?.hurdle;
      const graded = groupGraded || componentGraded || hurdle !== undefined;

      if (!graded) {
        items.push({ id: assignment.id, name: assignment.name, category: 'ungraded', graded: false,
          ...(groupWeight !== null ? { groupWeight } : {}) });
        continue;
      }

      if (component && componentKey && component.weight !== undefined && groupWeight !== null
        && component.weight !== groupWeight && !weightConflicts.has(componentKey)) {
        weightConflicts.set(componentKey, { field: 'weight', componentKey, skeletonValue: component.weight, canvasValue: groupWeight });
      }

      const choice = componentKey ? input.resolved?.weight?.[componentKey] : undefined;
      let effective: number | undefined;
      if (choice === 'skeleton') effective = component?.weight ?? 0;
      else if (choice === 'canvas') effective = groupWeight ?? 0;
      else if (groupWeight !== null && groupWeight > 0) effective = groupWeight;
      else if (component?.weight !== undefined) effective = component.weight;
      else if (component) effective = 0;

      // A classifier category of `ungraded` cannot make a weighted item count; keep the fact that it is unknown.
      const category = classification && classification.category !== 'ungraded' ? classification.category : 'unknown';
      items.push({ id: assignment.id, name: assignment.name, category, graded: true,
        ...(componentKey ? { componentKey } : {}),
        ...(groupWeight !== null ? { groupWeight } : {}),
        ...(effective !== undefined ? { effectiveComponentWeight: effective } : {}),
        ...(hurdle ? { hurdle } : {}) });

      if (!componentKey && !dismissed) {
        unmatched.push({ field: 'unmatched', canvasAssignmentId: assignment.id,
          canvasValue: { id: assignment.id, name: assignment.name, due: assignment.due.value } });
      }
    }
  }

  return { items, conflicts: [...weightConflicts.values(), ...unmatched] };
}
