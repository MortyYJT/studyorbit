import { courseKey, type DiscoveryResult, type SelectedCourse } from './discovery.js';
import type { CaptureSelection } from './selection-store.js';
export interface SelectionTerminal { write(message: string): void; question(prompt: string, options?: { signal?: AbortSignal }): Promise<string> }
export type PickerResult = { status: 'cancelled' } | { status: 'confirmed'; selection: CaptureSelection; gaps: DiscoveryResult[]; missing: SelectedCourse[] };
const displayLine = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
export async function pickCourses(discoveries: DiscoveryResult[], prior: CaptureSelection | undefined,
  terminal: SelectionTerminal, signal?: AbortSignal): Promise<PickerResult> {
  const choices = discoveries.flatMap(result => result.status === 'available' ? result.courses : []);
  const available = new Set(discoveries.filter(result => result.status === 'available').map(result => result.source));
  const keys = new Set(choices.map(courseKey));
  const missing = (prior?.courses ?? []).filter(course => available.has(course.source) && !keys.has(courseKey(course)));
  const retained = (prior?.courses ?? []).filter(course => !available.has(course.source));
  const ticks = new Set((prior?.courses ?? []).filter(course => keys.has(courseKey(course))).map(courseKey));
  const gaps = discoveries.filter(result => result.status === 'unavailable');
  discoveries.forEach(result => {
    if (result.status === 'available' && result.skipped > 0) terminal.write(`${result.source}: skipped ${result.skipped} inaccessible course row(s).`);
  });
  gaps.forEach(gap => terminal.write(`${gap.source} unavailable; previous choices retained.`));
  missing.forEach(course => terminal.write(`${course.source} course ${course.id} missing or inaccessible.`));
  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' };
    choices.forEach((course, index) => terminal.write(displayLine(`${index + 1}. [${ticks.has(courseKey(course)) ? 'x' : ' '}] ${course.source} | ${course.term.label} | ${course.code ?? ''} ${course.name}`)));
    let answer: string;
    try { answer = (await terminal.question('Toggle a number; done to confirm; q to cancel: ', { signal })).trim(); }
    catch (error) { if (signal?.aborted) return { status: 'cancelled' }; throw error; }
    if (signal?.aborted || answer === 'q') return { status: 'cancelled' };
    if (answer === 'done') return { status: 'confirmed', selection: { version: 1, courses: [...retained, ...choices.filter(course => ticks.has(courseKey(course))).map(({ source, origin, id, term }) => ({ source, origin, id, term }))] }, gaps, missing };
    const index = Number(answer) - 1;
    if (!/^\d+$/.test(answer) || !Number.isInteger(index) || !choices[index]) continue;
    const key = courseKey(choices[index]); if (ticks.has(key)) ticks.delete(key); else ticks.add(key);
  }
}
