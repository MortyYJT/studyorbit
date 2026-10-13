import { describe, expect, it } from 'vitest';
import { ChangeSchema } from '../../src/store/migrations/legacy-change.js';
import { synthetic } from '../fixtures/synthetic.js';

const task = synthetic.task;
const at = synthetic.run.startedAt;

describe('change snapshots', () => {
  const change = { seq: 1, entity: 'task', entityId: 'task-1', at };
  it('change without before or added with before is rejected', () => {
    expect(ChangeSchema.safeParse({ ...change, kind: 'updated', after: { due: at } }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind: 'created', before: task, after: task }).success).toBe(false);
  });
  it.each(['updated'])('%s requires both snapshots', kind => {
    expect(ChangeSchema.safeParse({ ...change, kind, before: {}, after: {} }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...change, kind, before: {} }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind, after: {} }).success).toBe(false);
  });
  it('added requires only after and removed requires only before', () => {
    expect(ChangeSchema.safeParse({ ...change, kind: 'created', after: task }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...change, kind: 'created' }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind: 'deleted', before: task }).success).toBe(true);
    expect(ChangeSchema.safeParse({ ...change, kind: 'deleted', before: task, after: task }).success).toBe(false);
    expect(ChangeSchema.safeParse({ ...change, kind: 'deleted' }).success).toBe(false);
  });
});

it('rejects historical specialized operations before migration operation mapping and invalid seq (2.2)', () => {
  for (const kind of ['item.added', 'item.removed', 'content.changed', 'deadline.changed', 'grade.changed']) {
    expect(ChangeSchema.safeParse({ seq: 1, kind, entity: 'task', entityId: 'task-1', before: {}, after: {}, at }).success).toBe(false);
  }
  for (const seq of [0, -1, 1.5, Infinity, undefined]) {
    expect(ChangeSchema.safeParse({ seq, kind: 'created', entity: 'task', entityId: 'task-1', after: {}, at }).success).toBe(false);
  }
});
