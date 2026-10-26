import type { CourseSelection } from '../domain/schemas.js';
import type { CourseMapInput, ItemsClassifyInput, QuizzesReadInput } from '../protocol/sync.js';
import type { CanvasAssignmentValue, GroupsStage } from './canvas-api.js';
import type { CourseComponent, CourseDocument, CourseItem, Field } from './course-json.js';
import { componentKeyFor, gradeItems, type GradedItem, type GradingCategory, type GradingConflict, type ResolvedChoices } from './grading.js';
import type { HandbookComponent, SkeletonStage } from './handbook.js';
import { edLessonEntries, type EdLessonEntry, type EdStage } from './ed-cli.js';

/**
 * Build the course document from the pipeline stages (layered-sync task 6.2, #212).
 *
 * Code, not an agent, turns the Handbook skeleton, Canvas API values, the home-page map, the routed outputs and the
 * classifier's categories into the existing contract. Page facts keep the read state that produced them: API values
 * carry `via: "api"` and the API URL, Handbook values carry the row quote and the assessment URL, and agent-read
 * values carry their quote. Grading (including weight conflicts) is `gradeItems`'; this module only maps its result.
 */

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const known = <T>(field: Field<T> | undefined): T | undefined =>
  field !== undefined && (field.state === 'found' || field.state === 'derived') && field.value !== null ? field.value : undefined;

const found = <T>(value: T, via: 'api' | 'ax' | 'handbook', extra: Partial<Field<T>> = {}): Field<T> =>
  ({ value, state: 'found', via, ...extra });
const derived = <T>(value: T): Field<T> => ({ value, state: 'derived' });
const unknownField = <T>(now: string): Field<T> => ({ value: null, state: 'unknown', checkedAt: now });
const notApplicable = <T>(): Field<T> => ({ value: null, state: 'not_applicable' });
/** The document contract caps a quote at 500 characters. */
const quoteText = (text: string): string => text.slice(0, 500);

const asGroups = (value: unknown): GroupsStage | undefined => {
  const stage = record(value);
  return stage && Array.isArray(stage.groups) ? stage as unknown as GroupsStage : undefined;
};
const asSkeleton = (value: unknown): SkeletonStage | undefined => {
  const stage = record(value);
  return stage && Array.isArray(stage.components) ? stage as unknown as SkeletonStage : undefined;
};
const asClassification = (value: unknown): ItemsClassifyInput | undefined => {
  const stage = record(value);
  return stage && Array.isArray(stage.items) ? stage as unknown as ItemsClassifyInput : undefined;
};
const asQuizzes = (value: unknown): QuizzesReadInput | undefined => {
  const stage = record(value);
  return stage && Array.isArray(stage.quizzes) ? stage as unknown as QuizzesReadInput : undefined;
};
const asEdStage = (value: unknown): EdStage | undefined => {
  const stage = record(value);
  return stage && (stage.via === 'api' || stage.via === 'ax') && Array.isArray(stage.lessons)
    ? stage as unknown as EdStage : undefined;
};

export interface BuildDocumentInput {
  course: CourseSelection;
  /** The course's finished stages: `skeleton`, `tabs`, `groups`, `map`, `quizzes`, `classification`, `assignments.<id>`, ... */
  stages: Record<string, unknown>;
  /** The instant unknown fields were checked. */
  now: string;
  /** The owner's settled choices for this course's open conflicts. */
  resolved?: ResolvedChoices;
  /** Platforms the run recorded behind a sign-in page, when Canvas produced no groups stage. */
  blocked?: readonly ('canvas' | 'ed')[];
}

export interface BuildDocumentResult {
  document: CourseDocument;
  conflicts: GradingConflict[];
  complete: boolean;
  /** Item `kind` paths the classifier left unknown after its retry; merged into the stored unknown fields. */
  unknown: string[];
  /** The synthetic component keys, so retry selection never infers them from a key suffix. */
  synthetic: { ungraded?: string; unassigned?: string };
}

/** A missing or unquoted policy cannot be a found document value, so it stays unknown. */
interface PolicyStageValue { value: 'allowed' | 'prohibited' | 'unknown'; quote?: string }
type Kind = 'exam' | 'quiz' | 'assignment' | 'presentation' | 'participation' | 'ungraded';
type PolicyFieldValue = 'allowed' | 'prohibited' | 'owner-attested';

function policyFromStage(value: unknown): PolicyStageValue | undefined {
  if (typeof value === 'string' && (value === 'allowed' || value === 'prohibited' || value === 'unknown')) {
    return { value };
  }
  const policy = record(value);
  const category = policy?.value;
  if (category !== 'allowed' && category !== 'prohibited' && category !== 'unknown') return undefined;
  return { value: category, ...(typeof policy?.quote === 'string' && policy.quote.trim() ? { quote: policy.quote } : {}) };
}

/** The stage written by `assignment.saved`, or a synthetic stage holding the policy directly. */
function assignmentPolicy(stages: Record<string, unknown>, id: string): PolicyStageValue | undefined {
  const stage = record(stages[`assignments.${id}`]);
  return policyFromStage(stage?.policy);
}

function itemPolicy(stages: Record<string, unknown>, id: string, url: string | undefined, now: string): Field<PolicyFieldValue> {
  const policy = assignmentPolicy(stages, id);
  if (!policy || policy.value === 'unknown' || !policy.quote || !url) return unknownField(now);
  return found(policy.value, 'ax', { quote: quoteText(policy.quote), source: url });
}

/** An optional synthetic stated weight, so a built document can still exercise "split what remains". */
function statedWeight(value: unknown, groups: GroupsStage | undefined, now: string): Field<number> {
  const field = record(value);
  if (field && (field.state === 'found' || field.state === 'derived') && typeof field.value === 'number') {
    return field as unknown as Field<number>;
  }
  if (typeof value === 'number' && groups?.source) return found(value, 'api', { source: groups.source });
  return unknownField(now);
}

function kindField(category: GradingCategory, now: string): Field<Kind> {
  return category === 'unknown' ? unknownField(now) : derived(category);
}

function mostCommonCategory(items: readonly GradedItem[]): GradingCategory | undefined {
  const counts = new Map<GradingCategory, number>();
  for (const item of items) {
    if (item.category === 'unknown') continue;
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  // Insertion order breaks a tie: the first category met in the group's item order wins.
  let best: GradingCategory | undefined;
  let bestCount = 0;
  for (const [category, count] of counts) {
    if (count > bestCount) { best = category; bestCount = count; }
  }
  return best;
}

function hurdleMinimum(component: HandbookComponent, skeleton: SkeletonStage | undefined, now: string): Field<number> {
  if (!component.hurdle) return notApplicable();
  // The first percentage is often the assessment weight; only a percentage a minimum phrase introduces counts.
  const match = /(?:at\s+least|minimum|pass(?:ing)?(?:\s+(?:mark|grade))?|achiev(?:e|es|ed)|obtain(?:s|ed)?)[^.;%\d]{0,60}?(\d{1,3}(?:\.\d+)?)\s*%/i.exec(component.hurdle);
  if (!match) return unknownField(now);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) return unknownField(now);
  return found(value, 'handbook', { quote: quoteText(component.hurdle), ...(skeleton?.source ? { source: skeleton.source } : {}) });
}

function componentWeight(component: HandbookComponent, key: string, items: readonly GradedItem[], groups: GroupsStage | undefined,
  skeleton: SkeletonStage | undefined, resolved: ResolvedChoices | undefined, now: string): Field<number> {
  const skeletonWeight = component.weight;
  const groupWeight = items.find(item => item.groupWeight !== undefined)?.groupWeight;
  const effective = items.find(item => item.effectiveComponentWeight !== undefined)?.effectiveComponentWeight ?? skeletonWeight;
  if (effective === undefined) return unknownField(now);
  const choice = resolved?.weight?.[key];
  const canvasEffective = choice === 'canvas' || (choice !== 'skeleton' && groupWeight !== undefined && groupWeight > 0);
  if (canvasEffective) {
    if (groups?.source) return found(effective, 'api', { source: groups.source });
    // No API source means the Canvas side cannot be a found value; the skeleton side still can.
    if (skeletonWeight !== undefined) return found(effective, 'handbook', { quote: quoteText(component.quote), ...(skeleton?.source ? { source: skeleton.source } : {}) });
    return unknownField(now);
  }
  return found(effective, 'handbook', { quote: quoteText(component.quote), ...(skeleton?.source ? { source: skeleton.source } : {}) });
}

interface Mids {
  key: string;
  name: Field<string>;
  kind: Field<Kind>;
  count: Field<number>;
  weight: Field<number>;
  hurdleMin: Field<number>;
  items: CourseItem[];
}

interface RetryItem { id: string; path: string }

/**
 * The compact list of items the classifier must look at again: graded items whose category is still unknown, and
 * items of a component whose kind is still unknown. Ungraded items are never a classification failure.
 */
function classificationRetries(document: CourseDocument, synthetic: BuildDocumentResult['synthetic']): RetryItem[] {
  const retries: RetryItem[] = [];
  const seen = new Set<string>();
  document.components.forEach((component, componentIndex) => {
    if (component.key === synthetic.ungraded) return;
    const unknownComponent = component.kind === undefined || component.kind.state === 'unknown' || component.kind.value === null;
    component.items.forEach((item, itemIndex) => {
      const id = /:canvas:assignment:(.+)$/.exec(item.key)?.[1];
      if (id === undefined || seen.has(id)) return;
      const unknownItem = item.kind === undefined || item.kind.state === 'unknown' || item.kind.value === null;
      if (!unknownComponent && !unknownItem) return;
      seen.add(id);
      retries.push({ id, path: `components[${componentIndex}].items[${itemIndex}].kind` });
    });
  });
  return retries;
}

export function classificationRetryIds(result: Pick<BuildDocumentResult, 'document' | 'synthetic'>): string[] {
  return classificationRetries(result.document, result.synthetic).map(entry => entry.id);
}

/** Build the one document the pipeline imports; `conflicts` are the grading pass's remaining disagreements. */
export function buildCourseDocument(input: BuildDocumentInput): BuildDocumentResult {
  const { course, stages, now, resolved } = input;
  const groups = asGroups(stages.groups);
  const skeleton = asSkeleton(stages.skeleton);
  const classification = asClassification(stages.classification);
  const quizzes = asQuizzes(stages.quizzes);
  const edStage = asEdStage(stages.ed);
  const edLessons = edStage ? edLessonEntries(edStage, course.code) : [];
  const edById = new Map(edLessons.map(entry => [entry.id, entry]));
  const map = record(stages.map) as CourseMapInput | undefined;

  const graded = gradeItems({ courseCode: course.code, ...(groups ? { groups } : {}), ...(skeleton ? { skeleton } : {}),
    ...(classification ? { classification } : {}), ...(quizzes ? { quizzes } : {}),
    ...(edLessons.length ? { edLessons } : {}), ...(resolved ? { resolved } : {}) });
  const gradedItems = graded.items.filter(item => item.graded);
  const ungradedItems = graded.items.filter(item => !item.graded);

  const assignmentById = new Map<string, CanvasAssignmentValue>();
  for (const group of groups?.groups ?? []) for (const assignment of group.assignments ?? []) {
    if (!assignmentById.has(assignment.id)) assignmentById.set(assignment.id, assignment);
  }

  // The key pattern only admits slug-shaped keys, so no synthetic key can be one a Handbook name cannot produce.
  // A synthetic key is reserved before a real component may take it; a colliding real component is suffixed instead.
  const rawSkeletonComponents = (skeleton?.components ?? []).flatMap(component => {
    const key = componentKeyFor(course.code, component.name);
    return key ? [{ key, component }] : [];
  });
  const rawKeys = new Set(rawSkeletonComponents.map(entry => entry.key));
  const unassignedItems = gradedItems.filter(item => item.componentKey === undefined || !rawKeys.has(item.componentKey));
  const synthetic: BuildDocumentResult['synthetic'] = {
    ...(ungradedItems.length ? { ungraded: `${course.code}:ungraded` } : {}),
    ...(unassignedItems.length ? { unassigned: `${course.code}:unassigned` } : {}),
  };
  // Both keys stay reserved in every run, so a real "Ungraded"/"Unassigned" component keeps one key across runs.
  const syntheticKeys = new Set([`${course.code}:ungraded`, `${course.code}:unassigned`]);
  const seenKeys = new Set<string>();
  const componentKeyByOriginal = new Map<string, string>();
  const skeletonComponents: { key: string; component: HandbookComponent }[] = [];
  for (const { key: originalKey, component } of rawSkeletonComponents) {
    let key = originalKey;
    if (syntheticKeys.has(key)) {
      do { key = `${key}-component`; } while (rawKeys.has(key) || syntheticKeys.has(key) || seenKeys.has(key));
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!componentKeyByOriginal.has(originalKey)) componentKeyByOriginal.set(originalKey, key);
    skeletonComponents.push({ key, component });
  }
  const resolvedComponentKey = (item: GradedItem): string | undefined =>
    item.componentKey === undefined ? undefined : componentKeyByOriginal.get(item.componentKey);

  const buildItem = (item: GradedItem): CourseItem => {
    const assignment = assignmentById.get(item.id);
    const stage = record(stages[`assignments.${item.id}`]);
    const url = assignment?.htmlUrl;
    const source = groups?.source;
    let weightField = statedWeight(assignment ? (assignment as unknown as Json).weight : undefined, groups, now);
    if (weightField.state === 'unknown' && stage?.weight !== undefined) weightField = statedWeight(stage.weight, groups, now);
    if (weightField.state === 'unknown') {
      const classified = record(classification?.items.find(entry => entry.id === item.id))?.weight;
      if (classified !== undefined) weightField = statedWeight(classified, groups, now);
    }
    return {
      key: `${course.code}:canvas:assignment:${item.id}`,
      ...(url ? { url } : {}),
      name: found(item.name, source ? 'api' : 'ax', source ? { source } : {}),
      kind: kindField(item.category, now),
      unlockAt: assignment?.unlockAt ?? unknownField<string>(now),
      due: assignment?.due ?? unknownField<string>(now),
      status: assignment?.status ?? unknownField<'not_started' | 'submitted' | 'graded'>(now),
      score: assignment?.score ?? unknownField<number>(now),
      outOf: assignment?.outOf ?? unknownField<number>(now),
      weight: weightField,
      aiPolicy: itemPolicy(stages, item.id, url, now),
    };
  };

  /** An Ed item has no points or Canvas state; name and due keep the stage that read them. */
  const buildEdItem = (item: GradedItem, entry: EdLessonEntry): CourseItem => {
    const fallbackSource = course.pages.ed;
    const quote = entry.quote ? { quote: quoteText(entry.quote) } : {};
    const page = entry.via === 'api' ? { source: entry.url } : { ...quote, ...(fallbackSource ? { source: fallbackSource } : {}) };
    return {
      key: entry.key,
      ...(entry.url ? { url: entry.url } : {}),
      name: found(entry.title, entry.via, page),
      kind: kindField(item.category, now),
      unlockAt: unknownField(now),
      due: found(entry.due, entry.via, page),
      status: derived('not_started'),
      score: notApplicable(),
      outOf: notApplicable(),
      weight: item.graded ? unknownField(now) : derived(0),
    };
  };

  const buildItemFor = (item: GradedItem): CourseItem => {
    const entry = edById.get(item.id);
    return entry ? buildEdItem(item, entry) : buildItem(item);
  };

  /** A graded Ed item shows the same derived even share the import would compute for its component. */
  const buildComponentItems = (items: readonly GradedItem[], weight: Field<number> | undefined): CourseItem[] => {
    const built = items.map(buildItemFor);
    const total = weight ? known(weight) : undefined;
    if (total === undefined) return built;
    const stated = built.filter(item => item.weight.state === 'found' && item.weight.value !== null);
    const slots = built.length - stated.length;
    if (slots <= 0) return built;
    const statedSum = stated.reduce((sum, item) => sum + (item.weight.value as number), 0);
    const share = Math.max(0, (total - statedSum) / slots);
    built.forEach((item, index) => {
      if (edById.has(items[index]!.id) && items[index]!.graded) item.weight = derived(share);
    });
    return built;
  };

  const mids: Mids[] = skeletonComponents.map(({ key, component }) => {
    const items = gradedItems.filter(item => resolvedComponentKey(item) === key);
    const category = mostCommonCategory(items);
    const weight = componentWeight(component, key, items, groups, skeleton, resolved, now);
    return {
      key,
      name: found(component.name, 'handbook', { quote: quoteText(component.quote), ...(skeleton?.source ? { source: skeleton.source } : {}) }),
      kind: kindField(category ?? 'unknown', now),
      count: items.length ? derived(items.length) : unknownField(now),
      weight,
      hurdleMin: hurdleMinimum(component, skeleton, now),
      items: buildComponentItems(items, weight),
    };
  });

  const ungradedComponent: Mids | undefined = synthetic.ungraded ? {
    key: synthetic.ungraded,
    name: derived('Ungraded'),
    kind: derived('ungraded'),
    count: derived(ungradedItems.length),
    weight: derived(0),
    hurdleMin: notApplicable(),
    items: ungradedItems.map(buildItemFor),
  } : undefined;

  const unassignedComponent: Mids | undefined = synthetic.unassigned ? {
    key: synthetic.unassigned,
    name: derived('Unassigned'),
    kind: kindField(mostCommonCategory(unassignedItems) ?? 'unknown', now),
    count: derived(unassignedItems.length),
    weight: unknownField(now),
    hurdleMin: notApplicable(),
    items: unassignedItems.map(buildItemFor),
  } : undefined;

  // One final at most: the heaviest exam component, with the first in Handbook order breaking a tie.
  const exams = mids.flatMap(entry => {
    const weight = known(entry.weight);
    return known(entry.kind) === 'exam' && weight !== undefined ? [{ key: entry.key, weight }] : [];
  });
  const finalKey = exams.length ? exams.reduce((best, entry) => entry.weight > best.weight ? entry : best).key : undefined;

  const components: CourseComponent[] = mids.map(entry => ({
    key: entry.key, name: entry.name, kind: entry.kind, count: entry.count, weight: entry.weight,
    isFinal: derived(entry.key === finalKey), hurdleMin: entry.hurdleMin, items: entry.items,
  }));
  for (const entry of [ungradedComponent, unassignedComponent]) {
    if (!entry) continue;
    components.push({ key: entry.key, name: entry.name, kind: entry.kind, count: entry.count, weight: entry.weight,
      isFinal: derived(false), hurdleMin: entry.hurdleMin, items: entry.items });
  }

  const policy = policyFromStage(map?.aiPolicy);
  const policySource = course.pages.canvas ?? course.pages.ed;
  const coursePolicy: Field<PolicyFieldValue> = policy && policy.value !== 'unknown' && policy.quote && policySource
    ? found(policy.value, 'ax', { quote: quoteText(policy.quote), source: policySource })
    : unknownField(now);
  const storedBlocked = Array.isArray(stages.blocked) ? stages.blocked as ('canvas' | 'ed')[] : [];
  const blocked = new Set(input.blocked?.length ? input.blocked : storedBlocked);
  const everyGradedItemHasComponent = gradedItems.every(item => resolvedComponentKey(item) !== undefined);

  const document: CourseDocument = {
    course: {
      code: found(course.code, 'api'),
      name: course.name && course.name.trim() ? found(course.name, 'api') : unknownField(now),
      term: found(course.term, 'api'),
      aiPolicy: coursePolicy,
      pages: { ...course.pages },
      platforms: { canvas: groups ? 'read' : blocked.has('canvas') ? 'blocked' : 'absent',
        ed: edStage ? 'read' : blocked.has('ed') ? 'blocked' : 'absent' },
      componentsComplete: skeleton !== undefined && everyGradedItemHasComponent,
    },
    components,
  };
  return { document, conflicts: graded.conflicts, complete: groups !== undefined && groups.coverage === 'api', synthetic,
    unknown: classificationRetries(document, synthetic).map(entry => entry.path) };
}
