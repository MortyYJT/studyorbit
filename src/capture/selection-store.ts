import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { dataDir } from '../config/data-dir.js';
import { CourseworkError } from '../protocol/errors.js';
import { CANVAS_ORIGIN, ED_ORIGIN, courseKey, type SelectedCourse } from './discovery.js';
export interface CaptureSelection { version: 1; courses: SelectedCourse[] }
const schema = z.strictObject({ version: z.literal(1), courses: z.array(z.strictObject({
  source: z.enum(['canvas', 'ed']), origin: z.string(), id: z.string().regex(/^\d+$/),
  term: z.strictObject({ label: z.string().trim().min(1), year: z.number().int().optional(), session: z.string().trim().min(1).optional() }),
})).superRefine((courses, ctx) => {
  const seen = new Set<string>();
  courses.forEach(course => {
    const key = courseKey(course);
    if (seen.has(key) || course.origin !== (course.source === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN)
      || course.source === 'ed' && (course.term.year === undefined || course.term.session === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid source-qualified course.' });
    }
    seen.add(key);
  });
}) });
export function validateSelection(value: unknown): CaptureSelection {
  const result = schema.safeParse(value);
  if (!result.success) throw new CourseworkError('INVALID_INPUT', 'Invalid capture selection.');
  return result.data;
}
export type SelectionLoad = { status: 'absent' | 'invalid' } | { status: 'valid'; selection: CaptureSelection };
export interface SelectionPersistence { load(): Promise<SelectionLoad>; save(selection: CaptureSelection): Promise<void> }
export class SelectionStore implements SelectionPersistence {
  constructor(private readonly directory?: string) {}
  private path(): string { return join(this.directory ?? dataDir(), 'capture-selection.json'); }
  async load(): Promise<SelectionLoad> {
    try { return { status: 'valid', selection: validateSelection(JSON.parse(await readFile(this.path(), 'utf8'))) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      return { status: 'invalid' };
    }
  }
  async save(selection: CaptureSelection): Promise<void> {
    const validated = validateSelection(selection);
    const path = this.path();
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(validated) + '\n'); await handle.sync();
      await handle.close(); await rename(temporary, path);
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
