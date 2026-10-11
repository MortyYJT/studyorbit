import { AssessmentSchema, CourseSchema, SourceItemSchema, type Assessment, type Course, type SourceItem } from '../domain/schemas.js';
import type { ChangeInput } from '../store/repository.js';
import { CourseworkError } from '../protocol/errors.js';

export type SyncEntity = 'course' | 'assessment' | 'source_item';
export type SyncValue = Course | Assessment | SourceItem;
export const syncSchemas = { course: CourseSchema, assessment: AssessmentSchema, source_item: SourceItemSchema };
/** Identity/bindings are immutable; owner fields require a separate explicit action. */
export const adapterFields: Record<SyncEntity, readonly string[]> = {
  course: ['code', 'name', 'term'],
  assessment: ['name', 'kind', 'weight', 'score', 'due', 'hurdleMin', 'isFinal', 'status'],
  source_item: ['kind', 'title', 'url', 'text', 'contentHash'],
};
export function invalidSync(): CourseworkError { return new CourseworkError('INVALID_INPUT', 'Invalid reconciliation input.'); }
export function canonicalEntity(entity: SyncEntity, input: unknown): SyncValue {
  const parsed = syncSchemas[entity].safeParse(input);
  if (!parsed.success) throw invalidSync();
  const value = parsed.data;
  if ('due' in value && value.due !== undefined) value.due = new Date(value.due).toISOString();
  return value;
}
/** Inputs have already passed the adapter privacy boundary; no raw capture belongs here. */
export function diffEntity(entity: SyncEntity, before: SyncValue | undefined, after: SyncValue | undefined,
  at: string, fields: readonly string[] = adapterFields[entity]): ChangeInput | undefined {
  if (fields.some(field => !adapterFields[entity].includes(field)) || new Set(fields).size !== fields.length) throw invalidSync();
  const old = before === undefined ? undefined : canonicalEntity(entity, before);
  const next = after === undefined ? undefined : canonicalEntity(entity, after);
  if (!old && !next) return undefined;
  if (!old) return { entity, entityId: next!.id, kind: 'created', after: next, at };
  if (!next) return { entity, entityId: old.id, kind: 'deleted', before: old, at };
  const a = old as unknown as Record<string, unknown>; const b = next as unknown as Record<string, unknown>;
  for (const key of ['id', 'courseId', 'platform', 'externalId']) {
    if (a[key] !== b[key]) throw invalidSync();
  }
  const merged = { ...a };
  for (const field of fields) {
    if (b[field] === undefined) delete merged[field]; else merged[field] = b[field];
  }
  if (fields.every(field => a[field] === merged[field])) return undefined;
  return { entity, entityId: old.id, kind: 'updated', before: old, after: canonicalEntity(entity, merged), at };
}
