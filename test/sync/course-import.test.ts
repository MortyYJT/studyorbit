import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { AnnotationService } from '../../src/protocol/annotations.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { hash } from '../../src/citations/exact.js';
import { validateCourseDocument } from '../../src/sync/course-json.js';
import { assessmentId, componentAssessmentId, importCourseDocument, remainderAssessmentId, sourceItemId } from '../../src/sync/course-import.js';
import { api, apiSource, component, document, found, item, now, quoted, unknown } from './course-document.js';

const stores: SqliteRepository[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const term = '2026:S2';
function setup() {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const save = (doc: Record<string, unknown>, final = false, at = now) => {
    const checked = validateCourseDocument(doc, { final, now: at });
    if (!checked.document) throw new Error(`invalid synthetic document: ${JSON.stringify(checked.errors)}`);
    return importCourseDocument(store, checked.document, { at });
  };
  const all = () => store.query('assessments', { limit: 500, includeRetired: true }).items;
  const live = () => store.query('assessments', { limit: 500 }).items;
  const get = (id: string) => store.loadAssessment(id);
  return { store, save, all, live, get };
}
const written = (items: Record<string, unknown>[], overrides = {}) => component('written', 15, items, { name: found('Written assignments'), count: found(4), ...overrides });
const exam = component('exam', 85, [], { kind: found('exam'), isFinal: found(true), count: found(1) });

describe('store mapping and precedence (coursework-sync)', () => {
  it('Items replace part of a placeholder: two of four items get 3.75 each and a 7.5 remainder keeps the rest', () => {
    const f = setup();
    const result = f.save(document([written([item(1), item(2)]), exam]));
    const group = { key: 'SYNA10001:written', name: 'Written assignments', weight: 15, count: 4 };
    for (const id of [1, 2]) {
      expect(f.get(assessmentId(term, `SYNA10001:canvas:assignment:${id}`))).toMatchObject({ weight: 3.75, kind: 'assignment', origin: 'sync', group: { ...group, role: 'item' },
        readState: { weight: { state: 'derived' } } });
    }
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))).toMatchObject({ name: 'Written assignments', weight: 7.5, group: { ...group, role: 'remainder' }, isFinal: false });
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))?.hurdleMin).toBeUndefined();
    expect(result).toMatchObject({ components: 2, items: 2 });
  });

  it('All items published: four item assessments exist and the remainder is retired, and returns when items disappear', () => {
    const f = setup();
    f.save(document([written([item(1), item(2)]), exam]));
    f.save(document([written([item(1), item(2), item(3), item(4)]), exam]));
    expect(f.live().filter(a => a.group?.key === 'SYNA10001:written').map(a => a.weight)).toEqual([3.75, 3.75, 3.75, 3.75]);
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))).toMatchObject({ retired: true });
    f.save(document([written([item(1), item(2), item(3)]), exam]));
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))).toMatchObject({ weight: 3.75 });
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))?.retired).toBeUndefined();
  });

  it('Owner value wins: an owner weight of 5 stays effective over an imported 3.75', () => {
    const f = setup();
    f.save(document([written([item(1), item(2)]), exam]));
    const id = assessmentId(term, 'SYNA10001:canvas:assignment:1');
    f.store.appendAnnotation({ id: 'owner-weight', entity: 'assessment', entityId: id, field: 'weight', value: 5, origin: 'owner', citations: [], at: now });
    f.save(document([written([item(1), item(2)]), exam]));
    const fields = new AnnotationService(f.store, new TrustedStoreEvidence(f.store)).read({ entity: 'assessment', entityId: id, limit: 0 }).fields;
    expect(fields.weight).toMatchObject({ value: 5, origin: 'owner' });
    expect(f.get(id)?.weight).toBe(3.75);
    // The remainder counts the item's effective weight.
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))?.weight).toBe(6.25);
  });

  it('Old API data is reused: the existing course is updated and its old sync assessments retired', () => {
    const f = setup();
    f.store.saveBatch({ modules: [{ id: 'school', name: 'Coursework', glyph: 'book', auto: true }],
      courses: [{ id: 'course:old', moduleId: 'school', code: 'SYNA10001', name: 'Old name', term, assessmentsComplete: false, sources: [{ platform: 'canvas', externalId: '900001' }] }],
      sourceItems: [{ id: 'old-group', platform: 'canvas', externalId: 'group:3', courseId: 'course:old', kind: 'material', title: 'Assignments', text: 'name: Assignments', contentHash: hash('x'), fetchedAt: now }],
      assessments: [{ id: 'old-assessment', courseId: 'course:old', name: 'Assignments', weight: 30, origin: 'sync', isFinal: false, status: 'not_started' },
        { id: 'agent-assessment', courseId: 'course:old', name: 'Agent', origin: 'agent', isFinal: false, status: 'not_started' }],
      assessmentLinks: [{ assessmentId: 'old-assessment', sourceItemId: 'old-group', origin: 'sync', at: now }] });
    const result = f.save(document());
    expect(result.courseId).toBe('course:old');
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([expect.objectContaining({ id: 'course:old', name: 'Synthetic Systems',
      sources: expect.arrayContaining([{ platform: 'canvas', externalId: '900001' }, { platform: 'ed', externalId: '800001' }]) })]);
    expect(f.get('old-assessment')).toMatchObject({ retired: true });
    expect(f.get('agent-assessment')?.retired).toBeUndefined();
  });

  it('Final exam with items: one component assessment of weight 50 with the hurdle, linked to the item, no remainder', () => {
    const f = setup();
    const final = component('final-exam', 50, [item(9, { due: quoted('2026-11-12T23:00:00Z') })],
      { name: found('Final exam'), kind: found('exam'), isFinal: found(true), hurdleMin: quoted(40), count: found(2) });
    f.save(document([final, component('other', 50, [item(1)])]));
    const id = componentAssessmentId(term, 'SYNA10001:final-exam');
    expect(f.get(id)).toMatchObject({ name: 'Final exam', weight: 50, isFinal: true, hurdleMin: 40, kind: 'exam', due: '2026-11-12T23:00:00Z', origin: 'sync', group: { role: 'component' } });
    expect(f.store.currentAssessmentLinks(id).map(link => link.sourceItemId)).toEqual([sourceItemId(term, 'SYNA10001:canvas:assignment:9')]);
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:9'))).toBeUndefined();
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:final-exam'))).toBeUndefined();
    expect(f.live().filter(a => a.isFinal)).toHaveLength(1);
  });

  it('Agent link kept: an item the agent linked to its own Workshops assessment keeps that link and counts against the remainder', () => {
    const f = setup();
    const workshops = component('workshops', 20, [item(1, { weight: quoted(5) }), item(2)], { count: found(3) });
    f.save(document([workshops, component('exam', 80, [], { kind: found('exam'), isFinal: found(true) })]));
    const source = sourceItemId(term, 'SYNA10001:canvas:assignment:1');
    const courseId = f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))!.courseId;
    f.store.saveBatch({ assessments: [{ id: 'agent-workshops', courseId, name: 'Workshops', origin: 'agent', isFinal: false, status: 'not_started' }],
      assessmentLinks: [{ assessmentId: 'agent-workshops', sourceItemId: source, origin: 'agent', at: now }] });
    f.save(document([workshops, component('exam', 80, [], { kind: found('exam'), isFinal: found(true) })]));
    expect(f.store.currentAssessmentLinks('agent-workshops').map(link => link.sourceItemId)).toEqual([source]);
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ retired: true });
    // 20 − 5 (kept item) − 7.5 (derived share of item 2) = 7.5.
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:workshops'))?.weight).toBe(7.5);
  });

  it('Blocked platform keeps its data: Ed rows are updated or retired as read, Canvas rows stay', () => {
    const f = setup();
    const mixed = (items: Record<string, unknown>[]) => document([component('work', 60, items, { count: unknown() }), exam]);
    f.save(mixed([item(1), item(2, {}, 'SYNA10001', 'ed'), item(3, {}, 'SYNA10001', 'ed')]));
    f.save(document([component('work', 60, [item(2, { name: found('Renamed on Ed') }, 'SYNA10001', 'ed')]), exam],
      { platforms: { canvas: 'blocked', ed: 'read' } }));
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))?.retired).toBeUndefined();
    expect(f.get(assessmentId(term, 'SYNA10001:ed:assignment:2'))).toMatchObject({ name: 'Renamed on Ed' });
    expect(f.get(assessmentId(term, 'SYNA10001:ed:assignment:3'))).toMatchObject({ retired: true });
  });

  it('a component with no items keeps its own weight read state on the remainder, not an even split', () => {
    const f = setup();
    f.save(document([written([item(1)]), component('project', 20, []), exam]));
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:project'))).toMatchObject({ weight: 20, readState: { weight: { state: 'found' } } });
    // With items listed, the rest of the component weight is computed, so it stays derived.
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:written'))?.readState?.weight).toEqual({ state: 'derived' });
  });

  it('remainder and component rows are retired only when the document reports componentsComplete', () => {
    const f = setup();
    f.save(document([written([item(1)]), component('project', 20, []), component('exam', 65, [], { kind: found('exam'), isFinal: found(true) })]));
    f.save(document([written([item(1)])], { componentsComplete: false }));
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:project'))?.retired).toBeUndefined();
    expect(f.get(componentAssessmentId(term, 'SYNA10001:exam'))?.retired).toBeUndefined();
    f.save(document([written([item(1)])]));
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:project'))).toMatchObject({ retired: true });
    expect(f.get(componentAssessmentId(term, 'SYNA10001:exam'))).toMatchObject({ retired: true });
  });

  it('writes SourceItems with facts and no page text, ids from term and key, score percentages and readState', () => {
    const f = setup();
    const graded = item(1, { status: found('graded'), score: found(8), outOf: found(10), weight: quoted(10) });
    const zero = item(2, { status: found('graded'), score: found(0), outOf: found(0) });
    f.save(document([component('work', 15, [graded, zero], { count: found(2) }), exam]));
    expect(f.store.loadSourceItem(sourceItemId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ platform: 'canvas', externalId: 'assignment:1',
      kind: 'assignment', title: 'Synthetic item 1', text: '', url: 'https://canvas.lms.unimelb.edu.au/courses/900001/assignments/1',
      facts: { due: '2026-10-30T12:59:00Z', pointsPossible: 10, pointsEarned: 8, submitted: true } });
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ score: 80, status: 'graded', weight: 10,
      readState: { weight: { state: 'found', quote: 'Synthetic quoted text' }, due: { state: 'found', via: 'ax' } } });
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:2'))?.score).toBeUndefined();
    expect(assessmentId(term, 'K')).not.toBe(assessmentId('2027:S2', 'K'));
  });

  it('floors a remainder at zero with a warning', () => {
    const f = setup();
    const doc = document([component('work', 15, [item(1, { weight: quoted(10) }), item(2)], { count: found(3) }), exam]);
    expect(f.save(doc).warnings).toEqual([]);
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:work'))?.weight).toBe(2.5);
    f.store.appendAnnotation({ id: 'owner-weight', entity: 'assessment', entityId: assessmentId(term, 'SYNA10001:canvas:assignment:2'),
      field: 'weight', value: 9, origin: 'owner', citations: [], at: now });
    expect(f.save(doc).warnings).toContain('REMAINDER_SHORTFALL');
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:work'))?.weight).toBe(0);
  });

  it('stores the agent-read AI policy with its quote and reports a changed value', () => {
    const f = setup();
    expect(f.save(document()).policyChanged).toBe(false);
    const result = f.save(document(undefined, { aiPolicy: quoted('prohibited', 'Generative AI is not permitted.') }));
    expect(result.policyChanged).toBe(true);
    expect(f.store.loadCourse(result.courseId)).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { state: 'found', quote: 'Generative AI is not permitted.' } } });
    expect(f.save(document(undefined, { aiPolicy: quoted('prohibited', 'Generative AI is not permitted.') })).policyChanged).toBe(false);
  });

  it('Missed policy read keeps the last value: an unknown read keeps prohibited and updates its check time', () => {
    const f = setup();
    const { courseId } = f.save(document(undefined, { aiPolicy: quoted('prohibited', 'No AI.') }));
    const later = '2026-10-25T02:00:00Z';
    const result = f.save(document(undefined, { aiPolicy: unknown(later) }), false, later);
    expect(result.policyChanged).toBe(false);
    expect(f.store.loadCourse(courseId)).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { state: 'found', quote: 'No AI.', checkedAt: later } } });
  });

  it('Item kind wins over the component kind, a missing item kind falls back, ongoing reads as participation', () => {
    const f = setup();
    f.save(document([
      component('work', 60, [item(1, { kind: found('presentation') }), item(2)], { kind: found('quiz'), count: found(2) }),
      component('legacy', 40, [item(3, { kind: found('ongoing') })], { kind: found('ongoing'), count: found(1) }),
    ]));
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ kind: 'presentation', readState: { kind: { state: 'found' } } });
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:2'))).toMatchObject({ kind: 'quiz', readState: { kind: { state: 'found' } } });
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:3'))).toMatchObject({ kind: 'participation' });
  });

  it('Item unlockAt lands on the Assessment and the SourceItem facts with its read state', () => {
    const f = setup();
    const unlockAt = '2026-10-01T00:00:00Z';
    f.save(document([component('work', 100, [item(1, { unlockAt: api(unlockAt) })], { count: found(1) })]));
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ unlockAt,
      readState: { unlockAt: { state: 'found', via: 'api', source: apiSource } } });
    expect(f.store.loadSourceItem(sourceItemId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ facts: { unlockAt } });
  });

  it('third-submission stand-in: a course without a name shows its code', () => {
    const f = setup();
    const result = f.save(document(undefined, { name: unknown() }), true);
    expect(f.store.loadCourse(result.courseId)).toMatchObject({ name: 'SYNA10001', readState: { name: { state: 'unknown' } } });
  });
});

describe('AI policy per assessment with a course default (coursework-sync)', () => {
  const work = (items: Record<string, unknown>[], overrides = {}) => component('work', 100, items, { count: found(items.length), ...overrides });
  const final = (slug: string, items: Record<string, unknown>[], overrides = {}) =>
    component(slug, 100, items, { kind: found('exam'), isFinal: found(true), count: found(items.length), ...overrides });
  const itemId = (id: number) => assessmentId(term, `SYNA10001:canvas:assignment:${id}`);

  it('Item policy read: a prohibited item keeps its quote while the course stays allowed and the change marker is set', () => {
    const f = setup();
    const quote = 'You must not use generative AI to write this report.';
    const result = f.save(document([work([item(1, { aiPolicy: quoted('prohibited', quote) })])],
      { aiPolicy: quoted('allowed', 'This subject allows generative AI with citation.') }));
    expect(result).toMatchObject({ policyChanged: true, itemPolicyChanges: 1 });
    expect(f.get(itemId(1))).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', via: 'ax', quote, source: 'https://canvas.lms.unimelb.edu.au/courses/900001/assignments/syllabus' },
        aiPolicyChanged: { state: 'found', checkedAt: now, quote } } });
    expect(f.store.loadCourse(result.courseId)).toMatchObject({ aiPolicy: 'allowed',
      readState: { aiPolicy: { state: 'found', quote: 'This subject allows generative AI with citation.' } } });
  });

  it('an unchanged item policy leaves an older change marker as is and is not counted again', () => {
    const f = setup();
    const quote = 'No AI for this report.';
    const doc = () => document([work([item(1, { aiPolicy: quoted('prohibited', quote) })])]);
    f.save(doc());
    const later = '2026-10-25T02:00:00Z';
    expect(f.save(doc(), false, later).itemPolicyChanges).toBe(0);
    expect(f.get(itemId(1))?.readState?.aiPolicyChanged).toEqual({ state: 'found', checkedAt: now, quote });
  });

  it('Missed item read keeps the last value and quote, updates checkedAt and writes no new marker', () => {
    const f = setup();
    const quote = 'No AI for this report.';
    f.save(document([work([item(1, { aiPolicy: quoted('prohibited', quote) })])]));
    // A value stored before change markers existed: the missed read must not invent one.
    const stored = f.get(itemId(1))!;
    const { aiPolicyChanged: _oldMarker, ...readState } = stored.readState!;
    f.store.saveBatch({ assessments: [{ ...stored, readState }] });
    const later = '2026-10-25T02:00:00Z';
    expect(f.save(document([work([item(1, { aiPolicy: unknown(later) })])]), false, later).itemPolicyChanges).toBe(0);
    expect(f.get(itemId(1))).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { state: 'found', quote, checkedAt: later } } });
    expect(f.get(itemId(1))?.readState?.aiPolicyChanged).toBeUndefined();
    // A skipped page has no aiPolicy field at all; the stored value and quote stay and only the check time moves.
    const skipped = '2026-10-26T02:00:00Z';
    f.save(document([work([item(1)])]), false, skipped);
    expect(f.get(itemId(1))).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { quote, checkedAt: skipped } } });
    expect(f.get(itemId(1))?.readState?.aiPolicyChanged).toBeUndefined();
  });

  it('Owner item policy kept: an owner allowed annotation stays while the agent-read prohibited and quote are stored', () => {
    const f = setup();
    const id = itemId(1);
    f.save(document([work([item(1)])]));
    f.store.appendAnnotation({ id: 'owner-policy', entity: 'assessment', entityId: id, field: 'aiPolicy', value: 'allowed', origin: 'owner', citations: [], at: now });
    const quote = 'No generative AI may be used for this report.';
    f.save(document([work([item(1, { aiPolicy: quoted('prohibited', quote) })])]));
    expect(f.store.readAnnotations('assessment', id).filter(row => row.field === 'aiPolicy'))
      .toEqual([expect.objectContaining({ value: 'allowed', origin: 'owner' })]);
    expect(f.get(id)).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { state: 'found', quote } } });
  });

  it('Component policy: prohibited wins, agreed known values agree, mixed with unknown keeps the known value, none known is absent', () => {
    const f = setup();
    const componentId = componentAssessmentId(term, 'SYNA10001:final');
    f.save(document([final('final', [item(1, { aiPolicy: quoted('prohibited', 'No AI.') })])]));
    expect(f.get(componentId)?.aiPolicy).toBe('prohibited');
    f.save(document([final('final', [item(2, { aiPolicy: quoted('allowed', 'AI allowed.') }), item(3, { aiPolicy: quoted('allowed', 'AI allowed.') })])]));
    expect(f.get(componentId)?.aiPolicy).toBe('allowed');
    f.save(document([final('final', [item(4, { aiPolicy: quoted('allowed', 'AI allowed.') }), item(5)])]));
    expect(f.get(componentId)?.aiPolicy).toBe('allowed');
    f.save(document([final('final', [item(6)])]));
    expect(f.get(componentId)?.aiPolicy).toBeUndefined();
  });

  it('Component policy survives a missed read and an item that later stands alone', () => {
    const f = setup();
    const detail = 'No generative AI is permitted for this final assessment.';
    const componentId = componentAssessmentId(term, 'SYNA10001:final');
    const finalDoc = (aiPolicy: Record<string, unknown>) => document([final('final', [item(1, { aiPolicy })])]);
    f.save(finalDoc(quoted('prohibited', detail)));
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'prohibited', readState: { aiPolicy: { state: 'found', quote: detail } } });
    const missed = '2026-10-25T02:00:00Z';
    f.save(finalDoc(unknown(missed)), false, missed);
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', quote: detail, checkedAt: missed } } });
    // A newly listed item has no previous row of its own; the component's stored prohibited value still wins.
    const replaced = '2026-10-25T03:00:00Z';
    f.save(document([final('final', [item(2, { aiPolicy: unknown(replaced) })])]), false, replaced);
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', quote: detail, checkedAt: replaced } } });
    // The component stops being final; its item now stands alone and misses its read too.
    const standalone = '2026-10-26T02:00:00Z';
    f.save(document([component('final', 100, [item(1, { aiPolicy: unknown(standalone) })], { count: found(1) })]), false, standalone);
    expect(f.get(itemId(1))).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', quote: detail, checkedAt: standalone } } });
  });

  it('A retired item row never supplies the previous policy for its component or a later standalone item', () => {
    const f = setup();
    const allowed = 'Generative AI is allowed with citation.';
    const prohibited = 'No generative AI for this component.';
    const componentId = componentAssessmentId(term, 'SYNA10001:final');
    f.save(document([work([item(1, { aiPolicy: quoted('allowed', allowed) })])]));
    expect(f.get(itemId(1))).toMatchObject({ aiPolicy: 'allowed' });
    const inComponent = '2026-10-25T02:00:00Z';
    f.save(document([final('final', [item(1, { aiPolicy: quoted('prohibited', prohibited) })])]), false, inComponent);
    expect(f.get(itemId(1))).toMatchObject({ retired: true, aiPolicy: 'allowed' });
    expect(f.get(componentId)?.aiPolicy).toBe('prohibited');
    const missed = '2026-10-26T02:00:00Z';
    f.save(document([final('final', [item(1, { aiPolicy: unknown(missed) })])]), false, missed);
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { quote: prohibited, checkedAt: missed } } });
    // Allowed standalone, prohibited in the component, then allowed standalone: a change from the component's value.
    const standalone = '2026-10-27T02:00:00Z';
    const result = f.save(document([work([item(1, { aiPolicy: quoted('allowed', allowed) })])]), false, standalone);
    expect(result.itemPolicyChanges).toBe(1);
    expect(f.get(itemId(1))).toMatchObject({ aiPolicy: 'allowed',
      readState: { aiPolicy: { state: 'found', quote: allowed }, aiPolicyChanged: { state: 'found', checkedAt: standalone, quote: allowed } } });
    expect(f.get(itemId(1))?.retired).toBeUndefined();
  });

  it('Component assessments record the deciding item read, keep it on missed reads, mark changes and count item changes', () => {
    const f = setup();
    const prohibited = 'No generative AI for this component.';
    const allowed = 'Generative AI is allowed with citation.';
    const componentId = componentAssessmentId(term, 'SYNA10001:final');
    const doc = (one: Record<string, unknown>, two: Record<string, unknown>) =>
      document([final('final', [item(1, { aiPolicy: one }), item(2, { aiPolicy: two })])]);
    const first = f.save(doc(quoted('prohibited', prohibited), quoted('allowed', allowed)));
    expect(first.itemPolicyChanges).toBe(2);
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', quote: prohibited }, aiPolicyChanged: { state: 'found', checkedAt: now, quote: prohibited } } });
    const missed = '2026-10-25T02:00:00Z';
    const second = f.save(doc(unknown(missed), unknown(missed)), false, missed);
    expect(second.itemPolicyChanges).toBe(0);
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'prohibited',
      readState: { aiPolicy: { state: 'found', quote: prohibited, checkedAt: missed },
        aiPolicyChanged: { state: 'found', checkedAt: now, quote: prohibited } } });
    const changed = '2026-10-26T02:00:00Z';
    const third = f.save(doc(quoted('allowed', allowed), quoted('allowed', allowed)), false, changed);
    expect(third.itemPolicyChanges).toBe(2);
    expect(f.get(componentId)).toMatchObject({ aiPolicy: 'allowed',
      readState: { aiPolicy: { state: 'found', quote: allowed }, aiPolicyChanged: { state: 'found', checkedAt: changed, quote: allowed } } });
  });

  it('Hurdle components combine their items and remainders store no policy', () => {
    const f = setup();
    const hurdle = component('hurdle', 50, [item(1, { aiPolicy: quoted('prohibited', 'No AI.') })],
      { kind: found('exam'), hurdleMin: quoted(40), count: found(1) });
    f.save(document([hurdle, component('rest', 50, [item(2, { aiPolicy: quoted('prohibited', 'No AI.') })], { count: found(2) })]));
    expect(f.get(componentAssessmentId(term, 'SYNA10001:hurdle'))?.aiPolicy).toBe('prohibited');
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:rest'))?.aiPolicy).toBeUndefined();
  });
});

describe('review fixes: no weight counted twice', () => {
  const total = (f: ReturnType<typeof setup>) => f.live().reduce((sum, a) => sum + (a.weight ?? 0), 0);
  it('a component that stops being final retires its component row even without componentsComplete', () => {
    const f = setup();
    f.save(document([component('exam', 50, [item(1)], { kind: found('exam'), isFinal: found(true), count: found(1) }), component('work', 50, [item(2)])]));
    expect(total(f)).toBe(100);
    f.save(document([component('exam', 50, [item(1)], { kind: found('exam'), isFinal: found(false), count: found(1) }), component('work', 50, [item(2)])],
      { componentsComplete: false }));
    expect(f.get(componentAssessmentId(term, 'SYNA10001:exam'))).toMatchObject({ retired: true });
    expect(total(f)).toBe(100);
  });

  it('an item moved to an agent link retires its old sync item row even without componentsComplete', () => {
    const f = setup();
    const workshops = component('workshops', 20, [item(1, { weight: quoted(5) }), item(2)], { count: found(3) });
    f.save(document([workshops, component('exam', 80, [], { kind: found('exam'), isFinal: found(true) })]));
    const courseId = f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))!.courseId;
    f.store.saveBatch({ assessmentLinks: [{ assessmentId: 'agent-workshops', sourceItemId: sourceItemId(term, 'SYNA10001:canvas:assignment:1'), origin: 'agent', at: now }],
      assessments: [{ id: 'agent-workshops', courseId, name: 'Workshops', origin: 'agent', isFinal: false, status: 'not_started' }] });
    f.save(document([workshops, component('exam', 80, [], { kind: found('exam'), isFinal: found(true) })], { componentsComplete: false }));
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:1'))).toMatchObject({ retired: true });
    // 7.5 item + 7.5 remainder + 80 exam; the agent's own Workshops row carries no weight here.
    expect(total(f)).toBe(95);
  });

  it('more listed items than count split over the listed items and warn COUNT_MISMATCH', () => {
    const f = setup();
    const result = f.save(document([component('work', 30, [item(1), item(2), item(3)], { count: found(2) }), component('exam', 70, [], { kind: found('exam'), isFinal: found(true) })]));
    expect([1, 2, 3].map(id => f.get(assessmentId(term, `SYNA10001:canvas:assignment:${id}`))?.weight)).toEqual([10, 10, 10]);
    expect(result.warnings).toContain('COUNT_MISMATCH');
  });

  it('a final component is graded only when all count items are listed and scored', () => {
    const f = setup();
    const scored = (id: number) => item(id, { status: found('graded'), score: found(8), outOf: found(10) });
    const final = (items: Record<string, unknown>[]) => component('final', 50, items, { kind: found('exam'), isFinal: found(true), count: found(2) });
    f.save(document([final([scored(1)]), component('work', 50, [item(3)])]));
    expect(f.get(componentAssessmentId(term, 'SYNA10001:final'))?.score).toBeUndefined();
    expect(f.get(componentAssessmentId(term, 'SYNA10001:final'))?.status).not.toBe('graded');
    f.save(document([final([scored(1), scored(2)]), component('work', 50, [item(3)])]));
    expect(f.get(componentAssessmentId(term, 'SYNA10001:final'))).toMatchObject({ score: 80, status: 'graded' });
  });
});

describe('unknown fields are re-checked and derived weights split evenly (coursework-sync)', () => {
  it('A due date appears later: an unknown due date becomes the found value', () => {
    const f = setup();
    f.save(document([component('work', 15, [item(1, { due: unknown() })], { count: found(1) }), exam]), true);
    const id = assessmentId(term, 'SYNA10001:canvas:assignment:1');
    expect(f.get(id)?.due).toBeUndefined();
    expect(f.get(id)?.readState?.due).toMatchObject({ state: 'unknown', checkedAt: now });
    f.save(document([component('work', 15, [item(1)], { count: found(1) }), exam]));
    expect(f.get(id)).toMatchObject({ due: '2026-10-30T12:59:00Z', readState: { due: { state: 'found' } } });
  });

  it('Even split: weight 15, count 4 and no item weights give 3.75 each, derived', () => {
    const f = setup();
    f.save(document([written([item(1), item(2), item(3), item(4)]), exam]));
    expect(f.live().filter(a => a.group?.key === 'SYNA10001:written').map(a => [a.weight, a.readState?.weight?.state]))
      .toEqual(Array.from({ length: 4 }, () => [3.75, 'derived']));
  });

  it('Split what remains: weight 20, count 3 and one stated 10 give the other two 5 each', () => {
    const f = setup();
    f.save(document([component('work', 20, [item(1, { weight: quoted(10) }), item(2), item(3)], { count: found(3) }), component('exam', 80, [], { kind: found('exam'), isFinal: found(true) })]));
    expect([1, 2, 3].map(id => f.get(assessmentId(term, `SYNA10001:canvas:assignment:${id}`))?.weight)).toEqual([10, 5, 5]);
    expect(f.get(assessmentId(term, 'SYNA10001:canvas:assignment:2'))?.readState?.weight?.state).toBe('derived');
    expect(f.get(remainderAssessmentId(term, 'SYNA10001:work'))).toBeUndefined();
  });
});
