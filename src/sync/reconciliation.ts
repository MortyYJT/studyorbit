import { z } from 'zod';
import { RunCoverageSchema } from '../domain/schemas.js';
import { adapterFields, canonicalEntity, invalidSync, type SyncEntity, type SyncValue } from './diff.js';

export const ScopeCoverageSchema = z.strictObject({
  selected: z.boolean(), enumerationComplete: z.boolean(), normalizationComplete: z.boolean(),
  codes: RunCoverageSchema.options[0].shape.codes,
});
export type ScopeCoverage = z.infer<typeof ScopeCoverageSchema>;
/** Complete normalization includes validated replacement of all pages of this material. */
export function canDeleteScope(collection: string, coverage: ScopeCoverage): boolean {
  return collection !== 'threads' && coverage.selected && coverage.enumerationComplete
    && coverage.normalizationComplete && coverage.codes.length === 0;
}
const ScopeSchema = z.strictObject({
  provider: z.enum(['canvas', 'ed']), courseId: z.string().min(1),
  collection: z.string().min(1), entity: z.enum(['course', 'assessment', 'source_item']),
  ownedIds: z.array(z.string().min(1)), fields: z.array(z.string()).min(1),
  values: z.array(z.unknown()), coverage: ScopeCoverageSchema,
});
/** Trusted adapter bindings for one exact collection (one file for PDF pages).
 * ownedIds contains the previously bound ids plus incoming ids, not a name/prefix guess.
 * This operational input is not a new persisted domain entity. Tasks/modules are never reconciled.
 */
export interface ReconcileScope {
  provider: 'canvas' | 'ed'; courseId: string; collection: string; entity: SyncEntity;
  ownedIds: readonly string[]; fields: readonly string[]; values: readonly SyncValue[]; coverage: ScopeCoverage;
}
export function validateScopes(input: readonly ReconcileScope[]): ReconcileScope[] {
  const parsed = z.array(ScopeSchema).safeParse(input);
  if (!parsed.success) throw invalidSync();
  const seen = new Set<string>();
  return parsed.data.map(scope => {
    const allowed = scope.provider === 'canvas'
      ? ['assignments', 'assignment_groups', 'submissions', 'modules', 'files', 'materials']
      : ['courses', 'lessons', 'attempts', 'slides', 'threads', 'resources', 'materials'];
    if (!allowed.includes(scope.collection) || new Set(scope.ownedIds).size !== scope.ownedIds.length
      || new Set(scope.fields).size !== scope.fields.length
      || scope.fields.some(field => !adapterFields[scope.entity].includes(field))) throw invalidSync();
    for (const id of scope.ownedIds) {
      const key = `${scope.entity}:${id}`;
      if (seen.has(key)) throw invalidSync();
      seen.add(key);
    }
    const ids = new Set<string>();
    const values = scope.values.map(raw => {
      const value = canonicalEntity(scope.entity, raw);
      if (!scope.ownedIds.includes(value.id) || ids.has(value.id)) throw invalidSync();
      ids.add(value.id);
      assertScopeMember({ ...scope, values: [] }, value);
      return value;
    });
    return { ...scope, values };
  });
}
export function assertScopeMember(scope: ReconcileScope, value: SyncValue): void {
  if (scope.entity === 'course' ? value.id !== scope.courseId : !('courseId' in value) || value.courseId !== scope.courseId) throw invalidSync();
  if (scope.entity === 'source_item' && (!('platform' in value) || value.platform !== scope.provider)) throw invalidSync();
}
