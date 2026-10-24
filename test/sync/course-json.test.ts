import { describe, expect, it } from 'vitest';
import { courseDocumentJsonSchema, courseKey, validateCourseDocument } from '../../src/sync/course-json.js';
import { component, document, found, item, now, quoted, unknown } from './course-document.js';

const check = (input: unknown, final = false) => validateCourseDocument(input, { final, now });
const paths = (result: ReturnType<typeof check>) => result.errors.map(error => error.path);

describe('course JSON contract (coursework-sync "Course JSON contract")', () => {
  it('Valid document: a document whose fields all follow the contract has no errors', () => {
    const result = check(document());
    expect(result.errors).toEqual([]);
    expect(result.fatal).toBe(false);
    expect(result.key).toBe('SYNA10001:2026:S2');
    expect(result.document?.components).toHaveLength(2);
  });

  it('Wrong field shape: a found due without a quote or with a non-ISO value names the field path', () => {
    const noQuote = item(1, { due: found('2026-10-30T12:59:00Z', { source: 'https://canvas.lms.unimelb.edu.au/courses/900001/assignments/1' }) });
    const notIso = item(2, { due: quoted('next Friday') });
    const result = check(document([component('assignments', 60, [noQuote, notIso], { count: found(2) }), component('exam', 40, [], { kind: found('exam') })]));
    expect(paths(result)).toEqual(expect.arrayContaining(['components[0].items[0].due.quote', 'components[0].items[1].due.value']));
  });

  it('accepts term formats YYYY:S1, S2, SUMMER and WINTER only', () => {
    for (const term of ['2026:S1', '2026:S2', '2026:SUMMER', '2026:WINTER']) expect(check(document(undefined, {}, 'SYNA10001', term)).errors.filter(e => e.path.startsWith('course.term'))).toEqual([]);
    expect(paths(check(document(undefined, {}, 'SYNA10001', '2026 Semester 2')))).toContain('course.term.value');
  });

  it('page URLs are accepted only on the Canvas and Ed origins', () => {
    expect(paths(check(document(undefined, { pages: { canvas: 'https://example.test/courses/1', ed: 'https://edstem.org/au/courses/1' } })))).toEqual(['course.pages.canvas']);
  });

  it('Missing name triggers a retry: an unknown course name is refused with the path course.name', () => {
    expect(paths(check(document(undefined, { name: unknown() })))).toEqual(['course.name']);
  });

  it('checks required fields, due years in Melbourne time, one final and item weights against the component weight', () => {
    const items = [item(1, { name: unknown() }), item(2, { due: quoted('2025-12-31T12:00:00Z') }), item(3, { status: unknown() }), item(4, { weight: quoted(30) })];
    const result = check(document([
      component('assignments', 20, items, { count: found(4) }),
      component('mid', 40, [], { kind: unknown(), isFinal: found(true) }),
      component('final', 40, [], { kind: found('exam'), isFinal: found(true) }),
    ]));
    expect(paths(result)).toEqual(expect.arrayContaining([
      'components[0].items[0].name', 'components[0].items[1].due', 'components[0].items[2].status', 'components[0].weight',
      'components[1].kind', 'components[1].isFinal', 'components[2].isFinal',
    ]));
    // 2026-12-31T13:30Z is already 2027 in Melbourne.
    expect(paths(check(document([component('a', 100, [item(1, { due: quoted('2026-12-31T13:30:00Z') })])])))).toEqual(['components[0].items[0].due']);
  });

  it('exam items need no due date', () => {
    const exam = component('final', 100, [item(1, { due: unknown() })], { kind: found('exam') });
    expect(check(document([exam])).errors).toEqual([]);
  });

  it('Third submission accepted with unknowns: still-failing due dates are stored as unknown with their check time', () => {
    const first = item(1, { due: unknown('2026-10-23T00:00:00Z') });
    const second = item(2, { due: quoted('2031-10-30T12:59:00Z') });
    const result = check(document([component('assignments', 60, [first, second], { count: found(2) }), component('exam', 40, [], { kind: found('exam') })]), true);
    expect(result.fatal).toBe(false);
    const stored = result.document!.components[0]!.items;
    expect(stored.map(entry => entry.due)).toEqual([
      { value: null, state: 'unknown', checkedAt: '2026-10-23T00:00:00Z' }, { value: null, state: 'unknown', checkedAt: now }]);
    expect(result.unknown).toEqual(expect.arrayContaining(['components[0].items[0].due', 'components[0].items[1].due']));
  });

  it('third-submission stand-ins: invalid items and components are left out, a nameless course keeps its code, several finals lose isFinal', () => {
    const result = check(document([
      component('assignments', 50, [item(1), item(2, { name: unknown() }), { key: 'not a key', name: found('Bad') }], { count: found(3) }),
      component('nameless', 10, [], { name: unknown() }),
      component('mid', 20, [], { kind: found('exam'), isFinal: found(true) }),
      component('final', 20, [], { kind: found('exam'), isFinal: found(true) }),
    ], { name: unknown() }), true);
    expect(result.fatal).toBe(false);
    const doc = result.document!;
    expect(doc.course.name).toMatchObject({ value: null, state: 'unknown' });
    expect(doc.components.map(c => c.key)).toEqual(['SYNA10001:assignments', 'SYNA10001:mid', 'SYNA10001:final']);
    expect(doc.components[0]!.items.map(i => i.key)).toEqual(['SYNA10001:canvas:assignment:1']);
    expect(doc.components.slice(1).map(c => c.isFinal.state)).toEqual(['unknown', 'unknown']);
    expect(result.dropped).toEqual(expect.arrayContaining(['components[0].items[1]', 'components[0].items[2]', 'components[1]']));
  });

  it('only a document without a valid code and term is refused on the third submission', () => {
    expect(check(document(undefined, { code: unknown() }), true)).toMatchObject({ fatal: true });
    expect(check(document(undefined, {}, 'SYNA10001', 'Semester 2'), true)).toMatchObject({ fatal: true });
    expect(check('not a document', true)).toMatchObject({ fatal: true });
  });

  it('Weights do not add up: a 90 total is accepted with a weight-sum warning', () => {
    const result = check(document([component('assignments', 50, [item(1)]), component('exam', 40, [], { kind: found('exam') })]));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'WEIGHT_SUM', sum: 90 }]);
  });

  it('keys start with the course code: component slug and item platform id', () => {
    expect(paths(check(document([component('a', 100, [item(1, {}, 'OTHR10001')])])))).toEqual(['components[0].items[0].key']);
    expect(courseKey('SYNA10001', '2026:S2')).toBe('SYNA10001:2026:S2');
  });

  it('shares one zod schema with the reading prompt as JSON Schema', () => {
    const schema = JSON.stringify(courseDocumentJsonSchema());
    for (const name of ['componentsComplete', 'platforms', 'hurdleMin', 'outOf', 'checkedAt', 'quote']) expect(schema).toContain(name);
  });
});
