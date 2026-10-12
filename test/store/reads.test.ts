import { describe, it, expect } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { examples } from '../../src/protocol/fakes.js';

describe('bounded current-state queries', () => {
  it('filters all entity collections and binds stable keyset cursors to filters', () => {
    const db = new SqliteRepository(':memory:');
    try {
      const course = examples['courses.list'].output.items[0];
      db.saveBatch({ courses: ['c','a','b'].map(id => ({ ...course, id })),
        assessments: examples['assessments.list'].output.items,
        tasks: examples['tasks.list'].output.items, runs: examples['runs.list'].output.items });
      db.saveSourceItem({ id: 'source', platform: 'manual', externalId: 'synthetic', courseId: course.id,
        kind: 'material', title: 'Guide', text: 'Synthetic text', contentHash: 'synthetic-hash', fetchedAt: '2026-01-01T00:00:00Z' });
      expect(db.query('sourceItems', { limit: 1, courseId: course.id, kind: 'material', id: 'source' }).items).toHaveLength(1);
      const assessment = examples['assessments.list'].output.items[0];
      expect(db.query('assessments', { limit: 1, courseId: assessment.courseId, kind: assessment.kind, status: assessment.status }).items).toHaveLength(1);
      const task = examples['tasks.list'].output.items[0];
      expect(db.query('tasks', { limit: 1, courseId: task.courseId, assessmentId: task.assessmentId, moduleId: task.moduleId }).items).toHaveLength(1);
      const run = examples['runs.list'].output.items[0];
      expect(db.query('runs', { limit: 1, command: run.command, outcome: run.outcome }).items).toHaveLength(1);
      const first = db.query('courses', { limit: 1, term: course.term });
      expect(first.items.map(c => c.id)).toEqual(['a']);
      db.saveCourse({ ...course, id: 'aa' });
      const second = db.query('courses', { limit: 2, term: course.term, cursor: first.nextCursor });
      expect(second.items.map(c => c.id)).toEqual(['aa', 'b']);
      expect(() => db.query('courses', { limit: 1, term: 'other', cursor: first.nextCursor })).toThrow();
      expect(() => db.query('tasks', { limit: 1, cursor: first.nextCursor })).toThrow();
      expect(() => db.query('courses', { limit: 0 })).toThrow();
      expect(() => db.query('courses', { limit: 501 })).toThrow();
      expect(() => db.query('courses', { limit: 1, cursor: 'garbage' })).toThrow();
      expect(db.query('assessments', { limit: 1, courseId: 'missing' }).items).toEqual([]);
      expect(db.query('assessments', { limit: 1, kind: 'assignment', status: 'not_started' }).items).toHaveLength(1);
      expect(db.query('tasks', { limit: 1, moduleId: 'missing' }).items).toEqual([]);
      expect(db.query('runs', { limit: 1, command: 'missing' }).items).toEqual([]);
      expect(db.query('sourceItems', { limit: 1, courseId: 'missing', kind: 'material' }).items).toEqual([]);
      expect(db.query('courses', { limit: 1, term: "' OR 1=1 --" }).items).toEqual([]);
    } finally { db.close(); }
  });
});
