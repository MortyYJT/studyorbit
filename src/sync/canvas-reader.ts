import { z } from 'zod';
import type { EdResponse } from '../capture/ed-transport.js';
import { CANVAS_ORIGIN } from './ed-scope.js';
import { safeCanvasEndpoint } from '../capture/canvas-transport.js';
import type { ProviderCourse } from './merge.js';
export type JsonResponse = EdResponse | { kind: 'json'; status: number; body: unknown; next?: string };
export interface JsonReader { read(endpoint: string): Promise<JsonResponse> }
export const providerId = z.union([z.number().int().positive().safe().transform(String), z.string().regex(/^[1-9]\d{0,15}$/)]);
const time = z.iso.datetime({ offset: true }).nullable().optional();
export const CanvasAssignmentSchema = z.object({ id: providerId, name: z.string(), assignment_group_id: providerId,
  description: z.string().nullable().optional(), due_at: time, points_possible: z.number().nonnegative().nullable().optional() }).passthrough();
export const CanvasGroupSchema = z.object({ id: providerId, name: z.string(), group_weight: z.number().min(0).max(100).nullable().optional() }).passthrough();
export const CanvasModuleSchema = z.object({ id: providerId, name: z.string() }).passthrough();
export const CanvasSubmissionSchema = z.object({ assignment_id: providerId, score: z.number().nonnegative().nullable().optional(),
  submitted_at: time, workflow_state: z.enum(['unsubmitted', 'submitted', 'graded', 'pending_review']) }).passthrough();
export const CanvasCourseSchema = z.object({ id: providerId, course_code: z.string(), name: z.string(),
  enrollments: z.array(z.object({ enrollment_state: z.string(), type: z.string() })),
  term: z.object({ name: z.string(), start_at: time, end_at: time }) }).passthrough();
export const canvasDiscovery = '/api/v1/courses?enrollment_type=student&enrollment_state=active&include[]=term&per_page=100&page=1';
/** Provider term labels, never course names, establish the shared term identity. */
export function termKey(label: string): string | undefined {
  const match = /(?:^|\D)(20\d{2})\D+(?:Semester\s*|SM|S)([12])(?:\D|$)/i.exec(label);
  return match ? `${match[1]}:S${match[2]}` : undefined;
}
export async function readCanvasCollection<S extends z.ZodType>(reader: JsonReader, endpoint: string, schema: S): Promise<{ rows: z.output<S>[]; complete: boolean }> {
  const rows: z.output<S>[] = []; const seen = new Set<string>(); const ids = new Set<string>();
  let current = endpoint;
  for (let page = 0; page < 20; page++) {
    if (seen.has(current) || !safeCanvasEndpoint(current)) return { rows, complete: false };
    seen.add(current);
    const response = await reader.read(current);
    if (response.kind !== 'json') return { rows, complete: false };
    const parsed = z.array(schema).max(100).safeParse(response.body);
    if (!parsed.success) return { rows, complete: false };
    for (const row of parsed.data) {
      const id = (row as { id?: string }).id;
      if (id && ids.has(id)) return { rows, complete: false };
      if (id) ids.add(id);
      rows.push(row);
    }
    const next = 'next' in response ? response.next : undefined;
    if (!next) return { rows, complete: true };
    try {
      const url = new URL(next, CANVAS_ORIGIN);
      const previous = new URL(current, CANVAS_ORIGIN);
      if (url.origin !== CANVAS_ORIGIN || url.username || url.password || url.hash || url.pathname !== previous.pathname) return { rows, complete: false };
      // Canonicalize provider URL encoding, then check the same approved query shape.
      current = url.pathname + '?' + decodeURIComponent(url.search.slice(1));
      if (current.replace(/page=\d+$/, '') !== endpoint.replace(/page=\d+$/, '')) return { rows, complete: false };
    } catch { return { rows, complete: false }; }
  }
  return { rows, complete: false };
}
export async function discoverCanvas(reader: JsonReader, at: string): Promise<{ courses: ProviderCourse[]; complete: boolean; raw: unknown }> {
  const result = await readCanvasCollection(reader, canvasDiscovery, CanvasCourseSchema);
  const courses: ProviderCourse[] = [];
  let complete = result.complete;
  for (const row of result.rows) {
    if (!row.enrollments.some(e => e.enrollment_state === 'active' && e.type.toLowerCase() === 'student')) continue;
    if (!row.term.start_at || !row.term.end_at) { complete = false; continue; }
    if (Date.parse(at) < Date.parse(row.term.start_at) || Date.parse(at) >= Date.parse(row.term.end_at)) continue;
    const term = termKey(row.term.name) ?? termKey(row.course_code);
    if (!term) { complete = false; continue; }
    courses.push({ provider: 'canvas', externalId: row.id, rawCode: row.course_code, name: row.name, term });
  }
  return { courses, complete, raw: result.rows };
}
