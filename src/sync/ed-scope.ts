import { z } from 'zod';
import { CourseworkError } from '../protocol/errors.js';
import { ED_ORIGIN } from '../capture/ed-transport.js';
export const CANVAS_ORIGIN = 'https://canvas.lms.unimelb.edu.au';
export interface EdSyncScope { version: 1; courses: z.infer<typeof schema>['courses'] }
const schema = z.strictObject({ version: z.literal(1), courses: z.array(z.strictObject({
  source: z.enum(['canvas', 'ed']), origin: z.string(), id: z.string().regex(/^\d+$/),
  term: z.strictObject({ label: z.string().trim().min(1), year: z.number().int().optional(), session: z.string().trim().min(1).optional() }),
})).superRefine((courses, ctx) => {
  const seen = new Set<string>();
  courses.forEach(course => {
    const key = `${course.source}:${course.origin}:${course.id}`;
    if (seen.has(key) || course.origin !== (course.source === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN)
      || course.source === 'ed' && (course.term.year === undefined || course.term.session === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid source-qualified course.' });
    }
    seen.add(key);
  });
}) });
export function validateEdScope(value: unknown): EdSyncScope {
  const result = schema.safeParse(value);
  if (!result.success) throw new CourseworkError('INVALID_INPUT', 'Invalid capture selection.');
  return result.data;
}

export { ED_ORIGIN };
