import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { AnnotationService } from '../../src/protocol/annotations.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { hash } from '../../src/citations/exact.js';
import { validateCourseDocument } from '../../src/sync/course-json.js';
import { assessmentId, componentAssessmentId, importCourseDocument, remainderAssessmentId, sourceItemId } from '../../src/sync/course-import.js';
import { component, document, found, item, now, quoted, unknown } from './course-document.js';

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

  it('third-submission stand-in: a course without a name shows its code', () => {
    const f = setup();
    const result = f.save(document(undefined, { name: unknown() }), true);
    expect(f.store.loadCourse(result.courseId)).toMatchObject({ name: 'SYNA10001', readState: { name: { state: 'unknown' } } });
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
