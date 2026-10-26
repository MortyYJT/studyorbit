import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CourseSchema, AssessmentSchema, TaskSchema, SourceItemSchema, RunSchema } from '../domain/schemas.js';
import { CourseworkError } from '../protocol/errors.js';
const paging = { limit: z.number().int().min(1).max(500), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional() };
const id = z.string().min(1).max(256);
export const queryDefinitions = {
  courses: { table: 'courses', schema: CourseSchema, filters: z.strictObject({ ...paging, term: z.string().optional() }) },
  // Retired assessments are left out unless a caller that maintains them (import) asks for them.
  assessments: { table: 'assessments', schema: AssessmentSchema, filters: z.strictObject({ ...paging, courseId: id.optional(), kind: AssessmentSchema.shape.kind.optional(), status: AssessmentSchema.shape.status.optional(), includeRetired: z.boolean().optional() }) },
  tasks: { table: 'tasks', schema: TaskSchema, filters: z.strictObject({ ...paging, courseId: id.optional(), assessmentId: id.optional(), moduleId: id.optional() }) },
  sourceItems: { table: 'source_items', schema: SourceItemSchema, filters: z.strictObject({ ...paging, courseId: id.optional(), id: id.optional(), continuationScope: z.string().max(1024).optional(), kind: SourceItemSchema.shape.kind.optional() }) },
  runs: { table: 'runs', schema: RunSchema, filters: z.strictObject({ ...paging, command: id.optional(), outcome: RunSchema.shape.outcome.optional() }) },
} as const;
export type Collection = keyof typeof queryDefinitions;
export type QueryInput<K extends Collection> = z.input<(typeof queryDefinitions)[K]['filters']>;
export type QueryItem<K extends Collection> = z.output<(typeof queryDefinitions)[K]['schema']>;
export interface QueryPage<T> { items: T[]; nextCursor?: string }
export interface CurrentStateReader {
  query<K extends Collection>(collection: K, input: QueryInput<K>): QueryPage<QueryItem<K>>;
}
const invalid = () => new CourseworkError('INVALID_INPUT', 'Invalid list filters or continuation.');
export function queryPlan<K extends Collection>(collection: K, input: QueryInput<K>, kindExpression = "json_extract(json, '$.kind')") {
  const definition = queryDefinitions[collection];
  if (!definition) throw invalid();
  const parsed = definition.filters.safeParse(input);
  if (!parsed.success) throw invalid();
  const { limit, cursor, ...filters } = parsed.data;
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  const scope = createHash('sha256').update(JSON.stringify([collection, entries])).digest('hex');
  let after: string | undefined;
  if (cursor) {
    try {
      const decoded = z.strictObject({ scope: z.literal(scope), after: id }).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      if (Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor) throw invalid();
      after = decoded.after;
    } catch { throw invalid(); }
  }
  // Keys are accepted only by the strict, collection-specific schema above; values are always bound.
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  for (const [key, value] of entries) {
    if (key === 'continuationScope' || key === 'includeRetired') continue;
    if (collection === 'assessments' && key === 'kind') {
      // v5 rows and annotations can still hold `ongoing`; the participation filter accepts both names (#184).
      if (value === 'participation') { clauses.push(`(${kindExpression} IN (?, ?))`); params.push('participation', 'ongoing'); }
      else { clauses.push(`${kindExpression} = ?`); params.push(value as string); }
      continue;
    }
    clauses.push(`json_extract(json, '$.${key}') = ?`);
    params.push(value as string);
  }
  if (collection === 'assessments' && (filters as { includeRetired?: boolean }).includeRetired !== true) clauses.push("COALESCE(json_extract(json, '$.retired'), 0) = 0");
  if (after !== undefined) { clauses.push('id > ?'); params.push(after); }
  params.push(limit + 1);
  return { sql: `SELECT json FROM ${definition.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`,
    params, limit, schema: definition.schema,
    cursorFor(last: string): string {
      if (!id.safeParse(last).success) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Record identity cannot be paged safely.');
      const token = Buffer.from(JSON.stringify({ scope, after: last })).toString('base64url');
      if (token.length > 512) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Record identity cannot be paged safely.');
      return token;
    } };
}
