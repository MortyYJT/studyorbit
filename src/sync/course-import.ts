import { createHash } from 'node:crypto';
import type { Assessment, AssessmentLink, Course, ReadState, SourceItem } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { currentLinks } from '../store/platform-state.js';
import { CANVAS_ORIGIN, ED_ORIGIN, type CourseDocument, type CourseItem, type Field } from './course-json.js';

/** Store mapping of one validated course document (#182, #183); see coursework-sync "Store mapping and precedence". */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** Item Assessments: term and item key. Component Assessments: term and component key. Keys of the two never collide. */
export const assessmentId = (term: string, itemKey: string) => sha256(`${term}:${itemKey}`);
export const componentAssessmentId = (term: string, componentKey: string) => sha256(`${term}:${componentKey}`);
export const remainderAssessmentId = (term: string, componentKey: string) => sha256(`${term}:${componentKey}:remainder`);
export const sourceItemId = (term: string, itemKey: string) => `source:${sha256(`source:${term}:${itemKey}`)}`;
export const newCourseId = (term: string, code: string) => `course:${sha256(`course:${term}:${code}`)}`;
const SCHOOL = { id: 'school', name: 'Coursework', glyph: 'book', auto: true };

export interface ImportOptions {
  at: string;
  /** The item's annotated weight (owner, else a valid agent annotation); undefined when only imported values exist. */
  annotatedWeight?: (assessmentId: string) => number | undefined;
}
export interface ImportResult {
  courseId: string; components: number; items: number; assessments: number; retired: number;
  warnings: ('REMAINDER_SHORTFALL' | 'COUNT_MISMATCH')[]; policyChanged: boolean; itemPolicyChanges: number;
}

const known = <T>(field: Field<T>): T | undefined => (field.state === 'found' || field.state === 'derived') && field.value !== null ? field.value : undefined;
const knownOptional = <T>(field: Field<T> | undefined): T | undefined => field === undefined ? undefined : known(field);
const entry = (field: Field<unknown>): ReadState[string] => ({ state: field.state, ...(field.via ? { via: field.via } : {}),
  ...(field.checkedAt ? { checkedAt: field.checkedAt } : {}), ...(field.quote ? { quote: field.quote } : {}), ...(field.source ? { source: field.source } : {}) });
const ownerWeight = (store: SqliteRepository) => (id: string) => {
  const row = store.readAnnotations('assessment', id).filter(annotation => annotation.origin === 'owner' && annotation.field === 'weight').at(-1);
  return typeof row?.value === 'number' ? row.value : undefined;
};
function platformCourseId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return /\/courses\/(\d+)(?:\/|$)/.exec(new URL(url).pathname)?.[1]; } catch { return undefined; }
}
function all<K extends 'courses' | 'assessments'>(store: SqliteRepository, collection: K, filters: Record<string, unknown>) {
  const rows: (K extends 'courses' ? Course : Assessment)[] = []; let cursor: string | undefined;
  do {
    const page = store.query(collection, { ...filters, limit: 500, cursor } as never);
    rows.push(...page.items as never[]); cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** One transaction per course; imported values are the lowest-precedence platform values, so annotations keep winning. */
export function importCourseDocument(store: SqliteRepository, document: CourseDocument, options: ImportOptions): ImportResult {
  const { at } = options;
  const code = document.course.code.value!; const term = document.course.term.value!;
  const annotated = options.annotatedWeight ?? ownerWeight(store);
  return store.transaction(() => {
    // An old API-sync course with the same code and term is reused rather than duplicated.
    const existing = all(store, 'courses', { term }).filter(course => course.code === code).sort((a, b) => a.id < b.id ? -1 : 1)[0];
    const courseId = existing?.id ?? newCourseId(term, code);
    const sources = [...existing?.sources ?? []];
    for (const platform of ['canvas', 'ed'] as const) {
      const externalId = platformCourseId(document.course.pages[platform]);
      if (externalId && !sources.some(source => source.platform === platform && source.externalId === externalId)) sources.push({ platform, externalId });
    }
    // A policy read as unknown never uncaps a course previously read as prohibited; a new read replaces the old one (#180).
    const readPolicy = known(document.course.aiPolicy);
    const policyChanged = readPolicy !== undefined && readPolicy !== existing?.aiPolicy;
    const aiPolicy = readPolicy ?? existing?.aiPolicy;
    // A missed read keeps the last found value and its quote, with the new check time.
    const policyState = readPolicy === undefined && aiPolicy !== undefined && existing?.readState?.aiPolicy
      ? { ...existing.readState.aiPolicy, checkedAt: document.course.aiPolicy.checkedAt ?? at } : entry(document.course.aiPolicy);
    const course: Course = { id: courseId, moduleId: existing?.moduleId ?? SCHOOL.id, code, name: known(document.course.name) ?? code, term,
      assessmentsComplete: existing?.assessmentsComplete ?? false, sources, ...(aiPolicy ? { aiPolicy } : {}),
      readState: { code: entry(document.course.code), name: entry(document.course.name), term: entry(document.course.term), aiPolicy: policyState } };

    const links = currentLinks(store.listAssessmentLinks());
    const previous = all(store, 'assessments', { courseId, includeRetired: true });
    const previousById = new Map(previous.map(assessment => [assessment.id, assessment]));
    const produced = new Map<string, Assessment>(); const sourceItems: SourceItem[] = []; const newLinks: AssessmentLink[] = [];
    const warnings = new Set<'REMAINDER_SHORTFALL' | 'COUNT_MISMATCH'>();
    // Item rows superseded by an agent or owner link: retired whatever the platform state, so no weight counts twice.
    const superseded = new Set<string>();
    const link = (assessment: string, sourceItem: string) => {
      const current = links.get(sourceItem);
      if (current && (current.origin !== 'sync' || current.assessmentId === assessment)) return;
      newLinks.push({ assessmentId: assessment, sourceItemId: sourceItem, origin: 'sync', at });
    };
    let itemCount = 0; let itemPolicyChanges = 0;
    for (const component of document.components) {
      const weight = known(component.weight); const count = known(component.count); const kind = known(component.kind);
      const name = known(component.name) ?? component.key;
      const group = { key: component.key, name, ...(weight !== undefined ? { weight } : {}), ...(count !== undefined ? { count } : {}) };
      const items = component.items; itemCount += items.length;
      // Stated weights win; the rest of the component weight is split evenly over the unstated slots (#171).
      const stated = items.map(item => item.weight.state === 'found' ? known(item.weight) : undefined);
      const statedSum = stated.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      // More listed items than the stated count: split over the listed items so the component never exceeds its weight.
      if (count !== undefined && items.length > count) warnings.add('COUNT_MISMATCH');
      const slots = Math.max(count ?? 0, items.length) - stated.filter(value => value !== undefined).length;
      const share = weight !== undefined && slots > 0 ? Math.max(0, (weight - statedSum) / slots) : undefined;
      const rows = items.map((item, index) => {
        const sourceId = sourceItemId(term, item.key);
        sourceItems.push(sourceItem(item, sourceId, courseId, at));
        const current = links.get(sourceId);
        const itemWeight = stated[index] ?? share;
        const weightState: ReadState[string] = stated[index] !== undefined ? entry(item.weight) : share !== undefined ? { state: 'derived' } : entry(item.weight);
        const id = assessmentId(term, item.key);
        const previousAssessment = previousById.get(id);
        const readPolicy = knownOptional(item.aiPolicy);
        // A missed item read (unknown or skipped page) keeps the previously stored agent-read policy.
        return { item, sourceId, id, previousAssessment, readPolicy, policy: readPolicy ?? previousAssessment?.aiPolicy,
          kept: current !== undefined && current.origin !== 'sync', weight: itemWeight, weightState };
      });
      if (known(component.isFinal) === true || known(component.hurdleMin) !== undefined) {
        // Finals and hurdled components stay one Assessment so the one-final rule and the hurdle keep working.
        const id = componentAssessmentId(term, component.key);
        const dues = rows.map(row => known(row.item.due)).filter((due): due is string => due !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b));
        const scores = rows.map(row => percent(row.item));
        // Graded only when every one of the component's items is listed and scored; otherwise the score is unknown.
        const scored = rows.length > 0 && rows.length >= (count ?? rows.length) && scores.every(score => score !== undefined);
        const weights = rows.map(row => row.weight);
        const useWeights = weights.every(value => value !== undefined) && weights.reduce<number>((sum, value) => sum + value!, 0) > 0;
        const score = scored ? scores.reduce<number>((sum, value, index) => sum + value! * (useWeights ? weights[index]! : 1), 0)
          / (useWeights ? weights.reduce<number>((sum, value) => sum + value!, 0) : rows.length) : undefined;
        const statuses = rows.map(row => known(row.item.status));
        const status = scored ? 'graded' : rows.length && statuses.every(value => value === 'submitted' || value === 'graded') ? 'submitted'
          : statuses.some(value => value && value !== 'not_started') ? 'in_progress' : 'not_started';
        const hurdleMin = known(component.hurdleMin);
        // A final or hurdled component mirrors its items: prohibited wins, then the value every known item agrees on.
        const policies = rows.map(row => row.policy).filter((value): value is NonNullable<Assessment['aiPolicy']> => value !== undefined);
        const componentPolicy = policies.includes('prohibited') ? 'prohibited'
          : policies.length > 0 && policies.every(value => value === policies[0]) ? policies[0] : undefined;
        produced.set(id, { id, courseId, name, ...(kind ? { kind } : {}), ...(weight !== undefined ? { weight } : {}), ...(score !== undefined ? { score } : {}),
          ...(dues[0] ? { due: dues[0] } : {}), ...(hurdleMin !== undefined ? { hurdleMin } : {}), ...(componentPolicy ? { aiPolicy: componentPolicy } : {}),
          isFinal: known(component.isFinal) === true, status, origin: 'sync', group: { ...group, role: 'component' },
          readState: { name: entry(component.name), kind: entry(component.kind), weight: entry(component.weight),
            isFinal: entry(component.isFinal), hurdleMin: entry(component.hurdleMin), ...(dues[0] ? { due: { state: 'derived' } } : {}) } });
        for (const row of rows) if (!row.kept) link(id, row.sourceId);
        continue;
      }
      let effectiveSum = 0; let sumKnown = true;
      const add = (value: number | undefined) => { if (value === undefined) sumKnown = false; else effectiveSum += value; };
      for (const row of rows) {
        // An item the agent or owner linked elsewhere keeps that link; its weight still counts against the remainder.
        if (row.kept) { superseded.add(assessmentId(term, row.item.key)); add(row.weight); continue; }
        const id = row.id;
        const due = known(row.item.due); const score = percent(row.item);
        const unlockAt = knownOptional(row.item.unlockAt); const itemKindField = row.item.kind;
        const itemKind = knownOptional(itemKindField) ?? kind;
        const aiPolicy = row.policy;
        const policyState: ReadState[string] = row.readPolicy === undefined && aiPolicy !== undefined
          ? { ...(row.previousAssessment?.readState?.aiPolicy ?? { state: 'found' }), checkedAt: row.item.aiPolicy?.checkedAt ?? at }
          : row.item.aiPolicy ? entry(row.item.aiPolicy) : { state: 'unknown', checkedAt: at };
        const policyChanged = row.readPolicy !== undefined && row.readPolicy !== row.previousAssessment?.aiPolicy;
        if (policyChanged) itemPolicyChanges++;
        // "Needs you" reads this marker while its checkedAt is not older than the last run start; an unchanged value keeps an older one.
        const policyMarker: ReadState[string] | undefined = policyChanged
          ? { state: 'found', checkedAt: at, ...(row.item.aiPolicy?.quote ? { quote: row.item.aiPolicy.quote } : {}) }
          : row.previousAssessment?.readState?.aiPolicyChanged;
        const kindState = itemKindField && known(itemKindField) !== undefined ? entry(itemKindField) : entry(component.kind);
        produced.set(id, { id, courseId, name: known(row.item.name)!, ...(itemKind ? { kind: itemKind } : {}), ...(row.weight !== undefined ? { weight: row.weight } : {}),
          ...(score !== undefined ? { score } : {}), ...(due ? { due } : {}), ...(unlockAt ? { unlockAt } : {}), ...(aiPolicy ? { aiPolicy } : {}),
          isFinal: false, status: known(row.item.status)!, origin: 'sync', group: { ...group, role: 'item' },
          readState: { name: entry(row.item.name), due: entry(row.item.due), status: entry(row.item.status), score: entry(row.item.score),
            outOf: entry(row.item.outOf), weight: row.weightState, kind: kindState,
            unlockAt: row.item.unlockAt ? entry(row.item.unlockAt) : { state: 'unknown', checkedAt: at },
            aiPolicy: policyState, ...(policyMarker ? { aiPolicyChanged: policyMarker } : {}) } });
        link(id, row.sourceId);
        add(annotated(id) ?? row.weight);
      }
      // The unpublished share stays in the grade until every item exists.
      if (!items.length || count !== undefined && items.length < count) {
        const id = remainderAssessmentId(term, component.key);
        let rest = weight !== undefined && sumKnown ? weight - effectiveSum : undefined;
        if (rest !== undefined && rest < -1e-9) warnings.add('REMAINDER_SHORTFALL');
        if (rest !== undefined) rest = Math.max(0, rest);
        produced.set(id, { id, courseId, name, ...(kind ? { kind } : {}), ...(rest !== undefined ? { weight: rest } : {}), isFinal: false, status: 'not_started',
          origin: 'sync', group: { ...group, role: 'remainder' }, readState: { name: entry(component.name), kind: entry(component.kind),
            // Without listed items the remainder is the whole component, so its weight is read, not computed.
            weight: !items.length && rest !== undefined ? entry(component.weight) : rest !== undefined ? { state: 'derived' } : { state: 'unknown', checkedAt: component.weight.checkedAt ?? at } } });
      }
    }

    // Retire sync rows the document no longer produces: item rows only for platforms read; component and remainder rows only
    // when the full grading breakdown was read. Agent and owner rows are never retired by import.
    const present = new Set(document.components.map(component => component.key));
    const retired: Assessment[] = [];
    for (const assessment of previous) {
      if (produced.has(assessment.id) || assessment.retired || (assessment.origin ?? 'sync') !== 'sync') continue;
      const groupKey = assessment.group?.key;
      const isRemainder = groupKey !== undefined && assessment.id === remainderAssessmentId(term, groupKey);
      const isComponent = groupKey !== undefined && assessment.id === componentAssessmentId(term, groupKey);
      let retire: boolean;
      // A remainder whose component now lists all items, or a component row whose component is no longer final or hurdled.
      if ((isRemainder || isComponent) && present.has(groupKey)) retire = true;
      else if (isRemainder || isComponent) retire = document.course.componentsComplete;
      else if (superseded.has(assessment.id)) retire = true;
      else {
        // The platform comes from every item ever linked to the row, not only current links (a moved item has none).
        const platforms = [...new Set(store.readAssessmentLinks(assessment.id).map(row => row.sourceItemId))].map(id => store.loadSourceItem(id)?.platform);
        retire = platforms.length === 0 ? document.course.componentsComplete
          : platforms.every(platform => platform === 'canvas' || platform === 'ed' ? document.course.platforms[platform] === 'read' : document.course.componentsComplete);
      }
      if (retire) retired.push({ ...assessment, retired: true });
    }
    store.saveBatch({ modules: existing || store.loadModule(SCHOOL.id) ? [] : [SCHOOL], courses: [course], sourceItems,
      assessments: [...produced.values(), ...retired], assessmentLinks: newLinks });
    return { courseId, components: document.components.length, items: itemCount, assessments: produced.size, retired: retired.length,
      warnings: [...warnings], policyChanged, itemPolicyChanges };
  });
}

function percent(item: CourseItem): number | undefined {
  const score = known(item.score); const outOf = known(item.outOf);
  return score !== undefined && outOf !== undefined && outOf > 0 ? Math.min(100, (score / outOf) * 100) : undefined;
}
function sourceItem(item: CourseItem, id: string, courseId: string, at: string): SourceItem {
  const [, platform, ...rest] = item.key.split(':') as [string, 'canvas' | 'ed', ...string[]];
  const facts: NonNullable<SourceItem['facts']> = {};
  const due = known(item.due); const outOf = known(item.outOf); const score = known(item.score); const status = known(item.status);
  const unlockAt = knownOptional(item.unlockAt);
  if (due) facts.due = due;
  if (unlockAt) facts.unlockAt = unlockAt;
  if (outOf !== undefined) facts.pointsPossible = outOf;
  if (score !== undefined) facts.pointsEarned = score;
  if (status) facts.submitted = status === 'submitted' || status === 'graded';
  const origin = platform === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN;
  const url = item.url && new URL(item.url).origin === origin ? item.url : undefined;
  const title = known(item.name)!;
  // No page text: imported items carry facts only; citable text comes from `source.record`.
  return { id, platform, externalId: rest.join(':'), courseId, kind: 'assignment', title, ...(url ? { url } : {}), text: '',
    contentHash: sha256(JSON.stringify([title, facts, url ?? null])), fetchedAt: at, removed: false, facts };
}
