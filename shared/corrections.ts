/**
 * The owner's corrections store in `.local/corrections/<courseId>.json` (openspec/changes/local-corrections-merge,
 * decisions #290-#298): schemas, the correction vocabulary of a synced course document, value equality, and the
 * normalisation that keeps only the fields the owner actually changed.
 *
 * Pure and browser-safe (no Node imports): the Node store in `scripts/lib/corrections-store.mjs` uses it today, and the
 * three-way merge of a later PR lives here too.
 */
import { z } from 'zod';
import { toDisplayDocument, type CourseDocument, type DisplayDocument } from './course-data.ts';

/** Canvas course IDs; also keeps the store file name safe. */
export const COURSE_ID = /^\d{1,20}$/;
export const isCourseId = (value: unknown): value is string => typeof value === 'string' && COURSE_ID.test(value);

/** Per-course limits; the API also caps a request body at 1 MB. */
export const CORRECTION_LIMITS = { corrections: 2000, manual: 500, order: 2000, bodyBytes: 1_000_000 } as const;

const kinds = ['exam', 'quiz', 'assignment', 'presentation', 'participation', 'hurdle', 'ungraded', 'unknown'] as const;
const natures = ['regular', 'ungraded', 'bonus', 'alternative'] as const;
const scorings = ['none', 'points', 'weighted'] as const;

/** Fields a correction can set that also have a synced value. */
export const overridableFields = ['name', 'kind', 'nature', 'weight', 'score', 'outOf', 'due', 'status', 'rule', 'scoring', 'parent', 'link'] as const;
export type OverridableField = (typeof overridableFields)[number];
/** Fields only the owner sets: never stripped, never in conflict. */
export const ownerOnlyFields = ['hidden', 'mergeInto', 'bonus'] as const;
const allFields: readonly string[] = [...overridableFields, ...ownerOnlyFields];

/** One correction, with the field types the page writes today (`null` clears a value). Unknown fields are rejected. */
export const CorrectionSchema = z.object({
  name: z.string(), kind: z.enum(kinds), nature: z.enum(natures), weight: z.number().nullable(), score: z.number().nullable(),
  outOf: z.number().nullable(), due: z.string().nullable(), status: z.string(), rule: z.string(), scoring: z.enum(scorings),
  parent: z.string(), link: z.string(), mergeInto: z.string(), hidden: z.boolean(), bonus: z.boolean(),
}).partial().strict();
export type Correction = z.infer<typeof CorrectionSchema>;

/** Synced value of every overridable field of one assessment, in correction vocabulary. */
export const FieldsSchema = z.object({
  name: z.string().nullable(), kind: z.string().nullable(), nature: z.string().nullable(), weight: z.number().nullable(),
  score: z.number().nullable(), outOf: z.number().nullable(), due: z.string().nullable(), status: z.string().nullable(),
  rule: z.string().nullable(), scoring: z.string().nullable(), parent: z.string().nullable(), link: z.string().nullable(),
}).strict();
export type Fields = z.infer<typeof FieldsSchema>;

/** A manual assessment as the page stores it: a key and a name are required, other fields are kept as given. */
const ManualSchema = z.object({ key: z.string().regex(/^\d{1,20}:manual:.+$/), name: z.string().refine(value => value.trim() !== '') }).loose();
export type ManualItem = z.infer<typeof ManualSchema>;

export const ConflictSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/), type: z.enum(['field', 'orphaned', 'dangling']), key: z.string(), assessmentId: z.string(),
  field: z.string().nullable(), base: z.unknown(), incoming: z.unknown(), user: z.unknown(), detectedAt: z.string(),
}).strict();
export type Conflict = z.infer<typeof ConflictSchema>;

/** The stored file. Anything that fails this schema is unreadable and is never overwritten. */
export const StoreSchema = z.object({
  version: z.literal(1),
  courseId: z.string().regex(COURSE_ID),
  revision: z.number().int().min(1),
  base: z.object({ digest: z.string().nullable(), assessments: z.record(z.string(), FieldsSchema) }).strict(),
  corrections: z.record(z.string(), CorrectionSchema),
  manual: z.array(ManualSchema),
  order: z.array(z.string()),
  pins: z.record(z.string(), z.array(z.enum(overridableFields))),
  conflicts: z.array(ConflictSchema),
  updatedAt: z.string(),
}).strict().superRefine((store, ctx) => {
  const prefix = `${store.courseId}:`;
  if (Object.keys(store.corrections).some(key => !key.startsWith(prefix))) ctx.addIssue({ code: 'custom', path: ['corrections'], message: 'correction keys must start with the course ID' });
  if (store.manual.some(item => !item.key.startsWith(`${prefix}manual:`))) ctx.addIssue({ code: 'custom', path: ['manual'], message: 'manual keys must belong to the course' });
});
export type CorrectionStore = z.infer<typeof StoreSchema>;

/** What the API returns for one course; the base stays on the server. */
export type CorrectionsView = { exists: boolean; revision: number; corrections: Record<string, Correction>; manual: ManualItem[]; order: string[]; conflicts: Conflict[] };
export const emptyView = (): CorrectionsView => ({ exists: false, revision: 0, corrections: {}, manual: [], order: [], conflicts: [] });
export const viewOf = (store: CorrectionStore): CorrectionsView => ({ exists: true, revision: store.revision, corrections: store.corrections, manual: store.manual, order: store.order, conflicts: store.conflicts });

export type CorrectionsInput = { revision?: number; corrections: Record<string, Correction>; manual: ManualItem[]; order: string[] };

/**
 * Validates a request body for one course: `{ corrections, manual, order }`, plus an integer `revision` >= 0 when
 * `options.revision` is set. Correction and manual keys must belong to the course; counts are capped (`TOO_LARGE`).
 */
export function parseCorrectionsInput(courseId: string, input: unknown, options: { revision?: boolean } = {}): { ok: true; value: CorrectionsInput } | { ok: false; error: 'INVALID_BODY' | 'TOO_LARGE' } {
  const schema = z.object({
    ...(options.revision ? { revision: z.number().int().min(0) } : {}),
    corrections: z.record(z.string(), CorrectionSchema), manual: z.array(ManualSchema), order: z.array(z.string()),
  }).strict();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'INVALID_BODY' };
  const value = parsed.data as CorrectionsInput;
  const prefix = `${courseId}:`;
  if (Object.keys(value.corrections).some(key => !key.startsWith(prefix)) || value.manual.some(item => !item.key.startsWith(`${prefix}manual:`))) return { ok: false, error: 'INVALID_BODY' };
  if (Object.keys(value.corrections).length > CORRECTION_LIMITS.corrections || value.manual.length > CORRECTION_LIMITS.manual || value.order.length > CORRECTION_LIMITS.order) return { ok: false, error: 'TOO_LARGE' };
  return { ok: true, value };
}

const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * An item key `<courseId>:<id>`, a group key `<courseId>:group:<courseId>:<id>`, a manual key (`<courseId>:manual:...` or the
 * group key of a manual parent), or none of these (null).
 */
export function parseKey(key: string, courseId: string): { type: 'item' | 'group'; id: string } | { type: 'manual' } | null {
  const prefix = `${courseId}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (rest.startsWith('manual:')) return { type: 'manual' };
  if (rest.startsWith('group:')) {
    const inner = rest.slice('group:'.length);
    if (!inner.startsWith(prefix) || inner.length === prefix.length) return null;
    const id = inner.slice(prefix.length);
    // A manual item can be a parent: its group row edits belong to the manual item, never to a synced assessment.
    return id.startsWith('manual:') ? { type: 'manual' } : { type: 'group', id };
  }
  return rest ? { type: 'item', id: rest } : null;
}

/** The synced value of every overridable field per assessment ID, in the vocabulary the page and corrections use. */
export function assessmentFields(document: CourseDocument | DisplayDocument, courseId: string): Record<string, Fields> {
  return Object.fromEntries(toDisplayDocument(document).assessments.map(item => [item.id, {
    name: item.name, kind: item.kind === 'test' ? 'exam' : item.kind === 'other' ? 'unknown' : item.kind, nature: item.nature,
    weight: item.weight, score: item.score, outOf: item.maxScore, due: item.due, status: item.status === 'unknown' ? null : item.status,
    rule: item.rule, scoring: item.scoring, parent: item.parentId ? `${courseId}:${item.parentId}` : null,
    link: item.sources.find(entry => entry.url)?.url ?? null,
  } satisfies Fields]));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Only a date-time with an explicit zone denotes an instant; a bare local time is compared as text.
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const melbourneDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const isEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * Whether two values of `field` are the same for the merge: empty values (undefined, null, blank) are equal; numbers
 * agree to two decimal places; due date-times with a zone are equal at the same instant, and a date-only due equals a
 * date-time on that calendar day in Australia/Melbourne; other strings compare trimmed.
 */
export function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  if (typeof a === 'number' && typeof b === 'number') return Math.round(a * 100) === Math.round(b * 100);
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.trim(), y = b.trim();
    if (field === 'due') {
      const instant = (value: string) => (ZONED.test(value) ? Date.parse(value) : NaN);
      const ix = instant(x), iy = instant(y);
      if (Number.isFinite(ix) && Number.isFinite(iy)) return ix === iy;
      if (DATE_ONLY.test(x) && Number.isFinite(iy)) return melbourneDay(iy) === x;
      if (DATE_ONLY.test(y) && Number.isFinite(ix)) return melbourneDay(ix) === y;
    }
    return x === y;
  }
  return a === b;
}

const definedFields = (correction: Correction) => Object.keys(correction).filter(field => (correction as Record<string, unknown>)[field] !== undefined);

/**
 * Keeps only what the owner changed (decision #292): an overridable item field equal to the base value, or a group field
 * equal to the effective item value (base overlaid by that assessment's item correction), is removed unless pinned; an
 * empty `status` is always removed; a correction left without fields is removed. Owner-only fields are kept, `link` is
 * stripped only when equal. Manual-item corrections and keys of neither form are kept as they are. Pins of removed fields
 * are dropped. Never modifies the input.
 */
export function normaliseCorrections(store: { courseId: string; base: CorrectionStore['base']; corrections: Record<string, Correction>; pins: Record<string, readonly string[]> }): { corrections: Record<string, Correction>; pins: Record<string, string[]> } {
  const { courseId, base } = store;
  const corrections: Record<string, Correction> = {};
  const pins: Record<string, string[]> = {};
  for (const [key, correction] of Object.entries(store.corrections)) {
    const parsed = parseKey(key, courseId);
    if (!parsed || parsed.type === 'manual') { corrections[key] = correction; continue; }
    const baseFields = own(base.assessments, parsed.id);
    const itemCorrection = parsed.type === 'group' ? own(store.corrections, `${courseId}:${parsed.id}`) : undefined;
    const pinned = own(store.pins, key) ?? [];
    const next: Record<string, unknown> = {};
    for (const field of definedFields(correction)) {
      const value = (correction as Record<string, unknown>)[field];
      if (field === 'status' && isEmpty(value)) continue;
      if ((overridableFields as readonly string[]).includes(field) && baseFields && !pinned.includes(field)) {
        let reference: unknown = baseFields[field as OverridableField];
        const itemValue = itemCorrection ? (itemCorrection as Record<string, unknown>)[field] : undefined;
        if (itemValue !== undefined && !(field === 'status' && isEmpty(itemValue))) reference = itemValue;
        if (sameValue(field, value, reference)) continue;
      }
      next[field] = value;
    }
    if (!Object.keys(next).length) continue;
    corrections[key] = next as Correction;
    const kept = pinned.filter(field => next[field] !== undefined);
    if (kept.length) pins[key] = kept;
  }
  return { corrections, pins };
}

/** Import only: the old parent form stored `due: null` on every save, so a group `due: null` is dropped (decision #292). */
export function dropImportNoise(corrections: Record<string, Correction>, courseId: string): Record<string, Correction> {
  return Object.fromEntries(Object.entries(corrections).map(([key, correction]) => {
    if (parseKey(key, courseId)?.type !== 'group' || correction.due !== null) return [key, correction];
    const { due: _dropped, ...rest } = correction;
    return [key, rest];
  }));
}

/** First 16 hex characters of sha256("<type>|<key>|<field>"), so one disagreement keeps one ID across merges. */
export function conflictId(type: Conflict['type'], key: string, field: string | null): string {
  return sha256Hex(`${type}|${key}|${field ?? ''}`).slice(0, 16);
}

/**
 * Conflicts for corrections that point at assessments absent from a newly adopted base (import, or the first save that
 * creates the store): `orphaned` for a correction whose assessment is missing (unless it only hides it), `dangling` for a
 * `parent`/`mergeInto` naming a missing item (manual keys excluded). A base with no digest raises nothing.
 */
export function transitionConflicts(corrections: Record<string, Correction>, base: CorrectionStore['base'], courseId: string, detectedAt: string): Conflict[] {
  if (base.digest === null) return [];
  const conflicts: Conflict[] = [];
  const present = (id: string) => Object.hasOwn(base.assessments, id);
  for (const [key, correction] of Object.entries(corrections)) {
    const parsed = parseKey(key, courseId);
    if (!parsed || parsed.type === 'manual') continue;
    for (const field of ['parent', 'mergeInto'] as const) {
      const target = correction[field];
      const reference = typeof target === 'string' ? parseKey(target, courseId) : null;
      if (reference?.type === 'item' && !present(reference.id)) {
        conflicts.push({ id: conflictId('dangling', key, field), type: 'dangling', key, assessmentId: parsed.id, field, base: null, incoming: null, user: target, detectedAt });
      }
    }
    const fieldsSet = definedFields(correction);
    if (!present(parsed.id) && !(fieldsSet.length === 1 && fieldsSet[0] === 'hidden')) {
      conflicts.push({ id: conflictId('orphaned', key, null), type: 'orphaned', key, assessmentId: parsed.id, field: null, base: null, incoming: null, user: { ...correction }, detectedAt });
    }
  }
  return conflicts;
}

/** Keeps the conflicts whose correction still exists and, for field and dangling conflicts, still sets that field. */
export function pruneConflicts(conflicts: Conflict[], corrections: Record<string, Correction>): Conflict[] {
  return conflicts.filter(conflict => {
    const correction = own(corrections, conflict.key);
    return !!correction && (conflict.field === null || (correction as Record<string, unknown>)[conflict.field] !== undefined);
  });
}

/**
 * Applies a save from the page (design §5). The forms resend every field, often in another notation, so a field counts as
 * changed only when the stored and sent values differ under `sameValue`. An unchanged field keeps its stored value, pin
 * and conflict; a changed field takes the sent value, loses its pin and closes its conflict (the owner chose by editing).
 * A correction missing from `sent` is deleted with its pins and conflicts. The result is not yet normalised.
 */
export function applyOwnerEdit(store: { corrections: Record<string, Correction>; pins: Record<string, readonly string[]>; conflicts: Conflict[] }, sent: Record<string, Correction>): { corrections: Record<string, Correction>; pins: Record<string, string[]>; conflicts: Conflict[] } {
  const corrections: Record<string, Correction> = {};
  const pins: Record<string, string[]> = {};
  const changed = new Set<string>();
  for (const [key, next] of Object.entries(sent)) {
    const stored = own(store.corrections, key);
    if (!stored) { corrections[key] = next; continue; }
    const merged: Record<string, unknown> = {};
    const names = new Set([...definedFields(stored), ...definedFields(next)]);
    for (const field of allFields.filter(name => names.has(name))) {
      const before = (stored as Record<string, unknown>)[field], after = (next as Record<string, unknown>)[field];
      if (sameValue(field, before, after)) { if (before !== undefined) merged[field] = before; continue; }
      changed.add(`${key}\u0000${field}`);
      if (after !== undefined) merged[field] = after;
    }
    corrections[key] = merged as Correction;
    const kept = (own(store.pins, key) ?? []).filter(field => !changed.has(`${key}\u0000${field}`));
    if (kept.length) pins[key] = kept;
  }
  const conflicts = pruneConflicts(store.conflicts.filter(conflict => conflict.field === null || !changed.has(`${conflict.key}\u0000${conflict.field}`)), corrections);
  return { corrections, pins, conflicts };
}

type MergeState = { corrections: Record<string, Correction>; pins: Record<string, readonly string[]>; conflicts: Conflict[] };

/**
 * Three-way merge of the owner's corrections with a new sync (design §4, decisions #291, #298). `base` holds the field
 * values the corrections were last reconciled with, `incoming` those of the new document, both by assessment ID. For every
 * item or group correction whose assessment is in `incoming`, each overridable field it sets is decided as:
 *
 * - owner value equal to the base and not pinned: dropped, so the sync value shows;
 * - owner value equal to the base and pinned: kept, with a `field` conflict when the sync changed it;
 * - sync value equal to the base (only the owner changed it): kept;
 * - sync value equal to the owner value (both changed alike): kept and pinned, and an open conflict on it is closed;
 * - all three different: kept, with a `field` conflict `{ base, incoming, user }`;
 * - no base entry for the assessment: the incoming value is the base, and nothing is recorded.
 *
 * `link` is never pinned and never conflicts; owner-only fields are always kept. A correction whose assessment was in the
 * base and is not in `incoming` is kept unchanged with an `orphaned` conflict unless it only hides it; a `parent` or
 * `mergeInto` naming such an item gets a `dangling` conflict. Both are raised only on that transition, and close when the
 * assessment is back. A new conflict replaces the open one with the same ID; conflicts on dropped fields close. The
 * result is normalised against `incoming`, which becomes the new base. Never modifies the input.
 */
export function mergeCorrections(base: Record<string, Fields>, incoming: Record<string, Fields>, store: MergeState & { courseId: string }, detectedAt: string): { corrections: Record<string, Correction>; pins: Record<string, string[]>; conflicts: Conflict[] } {
  const { courseId } = store;
  const corrections: Record<string, Correction> = {};
  const pins: Record<string, string[]> = {};
  const raised: Conflict[] = [];
  const closed = new Set<string>();
  const inBase = (id: string) => Object.hasOwn(base, id), inIncoming = (id: string) => Object.hasOwn(incoming, id);
  for (const [key, correction] of Object.entries(store.corrections)) {
    const parsed = parseKey(key, courseId);
    const pinned = [...(own(store.pins, key) ?? [])];
    if (!parsed || parsed.type === 'manual') { corrections[key] = correction; if (pinned.length) pins[key] = pinned; continue; }
    const { id } = parsed;
    for (const field of ['parent', 'mergeInto'] as const) {
      const reference = typeof correction[field] === 'string' ? parseKey(correction[field], courseId) : null;
      if (reference?.type !== 'item') continue;
      if (inBase(reference.id) && !inIncoming(reference.id)) {
        raised.push({ id: conflictId('dangling', key, field), type: 'dangling', key, assessmentId: id, field, base: null, incoming: null, user: correction[field], detectedAt });
      } else if (inIncoming(reference.id)) closed.add(conflictId('dangling', key, field));
    }
    const incomingFields = own(incoming, id);
    if (!incomingFields) {
      // Gone from the sync: kept as it is; flagged only on the present -> absent transition.
      corrections[key] = correction;
      if (pinned.length) pins[key] = pinned;
      for (const field of overridableFields) closed.add(conflictId('field', key, field));
      const set = definedFields(correction);
      if (inBase(id) && !(set.length === 1 && set[0] === 'hidden')) {
        // The base keeps the assessment's last synced fields, so the page can still name it.
        raised.push({ id: conflictId('orphaned', key, null), type: 'orphaned', key, assessmentId: id, field: null, base: own(base, id), incoming: null, user: { ...correction }, detectedAt });
      }
      continue;
    }
    closed.add(conflictId('orphaned', key, null));
    const baseFields = own(base, id) ?? incomingFields;
    const next: Record<string, unknown> = {};
    for (const field of definedFields(correction)) {
      const user = (correction as Record<string, unknown>)[field];
      if (!(overridableFields as readonly string[]).includes(field)) { next[field] = user; continue; }
      const name = field as OverridableField;
      const before = baseFields[name], after = incomingFields[name];
      const isPinned = pinned.includes(name);
      const conflict = (): Conflict => ({ id: conflictId('field', key, name), type: 'field', key, assessmentId: id, field: name, base: before, incoming: after, user, detectedAt });
      if (name === 'link') { if (isPinned || !sameValue(name, user, after)) next[name] = user; continue; }
      if (sameValue(name, user, before)) {
        if (!isPinned) continue;
        next[name] = user;
        if (!sameValue(name, after, before)) raised.push(conflict());
        continue;
      }
      next[name] = user;
      if (sameValue(name, after, before)) continue;
      if (sameValue(name, after, user)) {
        if (!isPinned) pinned.push(name);
        closed.add(conflictId('field', key, name));
        continue;
      }
      raised.push(conflict());
    }
    if (!Object.keys(next).length) continue;
    corrections[key] = next as Correction;
    if (pinned.length) pins[key] = pinned;
  }
  const replaced = new Map(raised.map(conflict => [conflict.id, conflict]));
  const kept = store.conflicts.filter(conflict => !closed.has(conflict.id) || replaced.has(conflict.id)).map(conflict => replaced.get(conflict.id) ?? conflict);
  const known = new Set(kept.map(conflict => conflict.id));
  const conflicts = [...kept, ...[...replaced.values()].filter(conflict => !known.has(conflict.id))];
  const normalised = normaliseCorrections({ courseId, base: { digest: null, assessments: incoming }, corrections, pins });
  return { ...normalised, conflicts: pruneConflicts(conflicts, normalised.corrections) };
}

/**
 * The owner's choice on one open conflict (design §5, decision #293). `sync`: a `field` or `dangling` conflict removes that
 * field (and its pin; the correction goes when it has no field left), an `orphaned` conflict removes the correction. `mine`
 * closes the conflict and changes nothing else. Conflicts on removed fields or corrections close too. Returns null when
 * no open conflict has that ID. Never modifies the input.
 */
export function resolveConflict(store: MergeState, id: string, choice: 'sync' | 'mine'): { corrections: Record<string, Correction>; pins: Record<string, string[]>; conflicts: Conflict[] } | null {
  const target = store.conflicts.find(conflict => conflict.id === id);
  if (!target) return null;
  const corrections = { ...store.corrections };
  const pins: Record<string, string[]> = Object.fromEntries(Object.entries(store.pins).map(([key, fields]) => [key, [...fields]]));
  if (choice === 'sync') {
    const correction = own(corrections, target.key);
    if (target.type === 'orphaned' || !target.field) delete corrections[target.key];
    else if (correction) {
      const { [target.field]: _removed, ...rest } = correction as Record<string, unknown>;
      if (Object.keys(rest).length) corrections[target.key] = rest as Correction; else delete corrections[target.key];
    }
    const left = (own(pins, target.key) ?? []).filter(field => field !== target.field && !!own(corrections, target.key));
    if (left.length) pins[target.key] = left; else delete pins[target.key];
  }
  return { corrections, pins, conflicts: pruneConflicts(store.conflicts.filter(conflict => conflict.id !== id), corrections) };
}

// SHA-256 (FIPS 180-4) over UTF-8, kept here so this module stays free of Node and async Web Crypto.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Lower-case hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array((((bytes.length + 9) + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      w[i] = w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d; h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + k;
  }
  return [...h].map(word => word.toString(16).padStart(8, '0')).join('');
}
