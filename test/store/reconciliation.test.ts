import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import type { ReconcileScope } from '../../src/sync/reconciliation.js';
import { adapterFields } from '../../src/sync/diff.js';
import { synthetic, syntheticAssessment } from '../fixtures/synthetic.js';
const at = '2026-01-01T00:00:00Z';
const stores: SqliteRepository[] = []; const dirs: string[] = [];
function open(path = ':memory:') { const db = new SqliteRepository(path); stores.push(db); return db; }
function path() { const dir = mkdtempSync(join(tmpdir(), 'reconcile-')); dirs.push(dir); return join(dir, 'db.sqlite'); }
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const a = syntheticAssessment('a', 20, 70);
function scope(values: ReconcileScope['values'] = [a]): ReconcileScope {
  return { provider: 'canvas', courseId: a.courseId, collection: 'assignments', entity: 'assessment',
    ownedIds: ['a', 'b'], fields: adapterFields.assessment, values,
    coverage: { selected: true, enumerationComplete: true, normalizationComplete: true, codes: [] } };
}
it('6.3 compares within transactions, prevents duplicate events with two writers and persists seq after removal/restart', () => {
  const file = path(); const first = open(file); const second = open(file);
  expect(first.reconcile([scope()], at).map(e => e.seq)).toEqual([1]);
  expect(second.reconcile([scope()], at)).toEqual([]);
  expect(second.reconcile([scope([{ ...a, score: 80 }])], at).map(e => e.seq)).toEqual([2]);
  expect(first.reconcile([scope([])], at)).toMatchObject([{ seq: 3, kind: 'deleted', before: { score: 80 } }]);
  expect(first.loadAssessment('a')).toBeUndefined(); first.close(); second.close();
  const reopened = open(file);
  expect(reopened.reconcile([scope()], at).map(e => e.seq)).toEqual([4]);
  expect(reopened.listChangesSince(0).map(e => e.seq)).toEqual([1, 2, 3, 4]);
});
it('6.3 rolls back deletion/upsert/events on validation or actual event insertion failure', () => {
  const db = open(); db.reconcile([scope()], at);
  const replace = scope([syntheticAssessment('b', 20)]);
  expect(() => db.reconcile([replace], 'invalid')).toThrow();
  expect(db.loadAssessment('a')).toEqual(JSON.parse(JSON.stringify(a))); expect(db.loadAssessment('b')).toBeUndefined();
  // Inject failure at the store write boundary, after the first event has actually been inserted.
  const internal = db as unknown as { appendChange: (input: unknown) => unknown };
  const append = internal.appendChange.bind(db); let calls = 0;
  internal.appendChange = input => { if (++calls === 2) throw new Error('synthetic insertion failure'); return append(input); };
  expect(() => db.reconcile([replace], at)).toThrow('synthetic insertion failure');
  internal.appendChange = append;
  expect(db.loadAssessment('a')).toEqual(JSON.parse(JSON.stringify(a))); expect(db.loadAssessment('b')).toBeUndefined();
  expect(db.listChangesSince(0).map(e => e.seq)).toEqual([1]);
  expect(db.reconcile([replace], at).map(e => e.seq)).toEqual([2, 3]);
});
it('6.2 retains partial, failed, deselected scopes while independently complete scopes publish', () => {
  const db = open(); db.reconcile([scope()], at);
  for (const codes of [['INCOMPLETE'], ['AUTH_EXPIRED'], ['LIMIT_EXCEEDED'], ['CANCELED'], ['SKIPPED'], ['SOURCE_UNAVAILABLE']]) {
    const missing = scope([]); missing.coverage.codes = codes as ReconcileScope['coverage']['codes'];
    expect(db.reconcile([missing], at)).toEqual([]); expect(db.loadAssessment('a')).toEqual(JSON.parse(JSON.stringify(a)));
  }
  const failed = scope([{ ...a, score: 99 }]); failed.coverage.normalizationComplete = false;
  const complete = scope([syntheticAssessment('b', 20)]); complete.ownedIds = ['b'];
  failed.ownedIds = ['a'];
  expect(db.reconcile([failed, complete], at)).toMatchObject([{ entityId: 'b', kind: 'created' }]);
  expect(db.loadAssessment('a')?.score).toBe(70);
  failed.coverage.selected = false; failed.coverage.normalizationComplete = true;
  expect(db.reconcile([failed], at)).toEqual([]);
});
it('6.2 protects manual sources, owner course fields, tasks/modules and collection membership', () => {
  const db = open(); db.saveSourceItem(synthetic.sourceItem); db.saveTask(synthetic.task); db.saveModule(synthetic.module); db.saveCourse(synthetic.course);
  const manual: ReconcileScope = { ...scope([]), entity: 'source_item', collection: 'materials', ownedIds: [synthetic.sourceItem.id], fields: adapterFields.source_item };
  expect(() => db.reconcile([manual], at)).toThrow();
  const course: ReconcileScope = { ...scope([{ ...synthetic.course, name: 'Updated' }]), entity: 'course', ownedIds: [synthetic.course.id], fields: ['name'] };
  db.reconcile([course], at);
  expect(db.loadCourse(synthetic.course.id)).toMatchObject({ name: 'Updated', moduleId: synthetic.module.id, assessmentsComplete: true });
  expect(db.loadTask(synthetic.task.id)).toEqual(synthetic.task); expect(db.loadModule(synthetic.module.id)).toEqual(synthetic.module);
  expect(db.loadSourceItem(synthetic.sourceItem.id)).toEqual(synthetic.sourceItem);
  expect(() => db.reconcile([{ ...scope(), fields: ['courseId'] }], at)).toThrow();
  expect(() => db.reconcile([scope([{ ...a, courseId: 'unselected' }])], at)).toThrow();
  expect(() => db.reconcile([scope(), scope()], at)).toThrow();
});
it('6.2 retains old PDF pages on failed extraction and first-page posts on complete transport', () => {
  const db = open();
  const source = { ...synthetic.sourceItem, platform: 'ed' as const };
  const s: ReconcileScope = { ...scope([source]), provider: 'ed', entity: 'source_item', collection: 'materials', ownedIds: [source.id], fields: adapterFields.source_item };
  db.reconcile([s], at);
  expect(db.reconcile([{ ...s, values: [], coverage: { ...s.coverage, normalizationComplete: false } }], at)).toEqual([]);
  expect(db.reconcile([{ ...s, values: [], collection: 'threads' }], at)).toEqual([]);
  expect(db.reconcile([{ ...s, values: [] }], at)).toMatchObject([{ kind: 'deleted', before: source }]);
});
it('6.2 failed coverage with valid-looking incoming rows cannot replace prior state', () => {
  const db = open(); db.reconcile([scope()], at);
  const failed = scope([{ ...a, score: 99 }]); failed.coverage.codes = ['AUTH_EXPIRED'];
  expect(db.reconcile([failed], at)).toEqual([]);
  expect(db.loadAssessment('a')?.score).toBe(70);
});
it('6.3 invalid later scope rolls back earlier publication and leaves cursor unchanged', () => {
  const db = open(); db.reconcile([scope()], at);
  const first = scope([{ ...a, score: 80 }]); first.ownedIds = ['a'];
  db.saveSourceItem(synthetic.sourceItem);
  const invalid: ReconcileScope = { ...scope([]), entity: 'source_item', collection: 'materials', ownedIds: [synthetic.sourceItem.id], fields: adapterFields.source_item };
  expect(() => db.reconcile([first, invalid], at)).toThrow();
  expect(db.loadAssessment('a')?.score).toBe(70); expect(db.listChangesSince(0)).toHaveLength(1);
  expect(db.reconcile([first], at).map(e => e.seq)).toEqual([2]);
});
it('6.3 rolls back state writes when generated event validation fails inside publication', () => {
  const db = open(); db.reconcile([scope()], at);
  const internal = db as unknown as { appendChange: (input: unknown) => unknown };
  const append = internal.appendChange.bind(db);
  internal.appendChange = input => append({ ...(input as object), at: 'invalid' });
  expect(() => db.reconcile([scope([syntheticAssessment('b', 20)])], at)).toThrow();
  internal.appendChange = append;
  expect(db.loadAssessment('a')?.score).toBe(70); expect(db.loadAssessment('b')).toBeUndefined();
  expect(db.listChangesSince(0)).toHaveLength(1);
  expect(db.reconcile([scope([syntheticAssessment('b', 20)])], at).map(e => e.seq)).toEqual([2, 3]);
});
