import { it, expect, vi } from 'vitest';
import { pickCourses } from '../../src/capture/picker.js';
import { resolveSelection } from '../../src/capture/selection-resolver.js';
import { normalizeCanvasCourses, unavailable, ED_ORIGIN } from '../../src/capture/discovery.js';
const discovery = normalizeCanvasCourses([{ id: '42', name: 'Synthetic', term: 'Course Term' }, { id: '43', name: 'Community', term: '默认学期' }]);
const prior = { version: 1 as const, courses: [{ source: 'ed' as const, origin: ED_ORIGIN, id: '7', term: { label: '2025 Semester 1', year: 2025, session: 'Semester 1' } }] };
function terminal(answers: string[]) { return { write: vi.fn(), question: vi.fn(async () => answers.shift() ?? 'q') }; }
it('ticks independently with no default and retains unavailable-source choices', async () => {
  const term = terminal(['1', 'done']);
  const result = await pickCourses([discovery, unavailable('ed')], prior, term);
  expect(result.status).toBe('confirmed');
  if (result.status !== 'confirmed') return;
  expect(result.selection.courses.map(c => c.id)).toEqual(['7', '42']);
  expect(term.write.mock.calls.flat().join(' ')).toContain('ed');
  const empty = await pickCourses([discovery], undefined, terminal(['done']));
  expect(empty).toMatchObject({ selection: { courses: [] } });
});
it('first save/reuse, explicit refresh, cancel and missing choices', async () => {
  let stored: any = { status: 'absent' }; const save = vi.fn(async selection => { stored = { status: 'valid', selection }; });
  const store = { load: async () => stored, save }; const discover = vi.fn(async () => [discovery]);
  expect(await resolveSelection({ isTTY: true, store, discover, terminal: terminal(['1', 'done']) })).toMatchObject({ status: 'ready', selection: { courses: [{ id: '42' }] } });
  await resolveSelection({ isTTY: true, store, discover, terminal: terminal([]) }); expect(discover).toHaveBeenCalledTimes(1);
  expect(await resolveSelection({ isTTY: true, reselect: true, store, discover, terminal: terminal(['q']) })).toMatchObject({ status: 'cancelled' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(await resolveSelection({ isTTY: true, reselect: true, store, discover, terminal: terminal(['2', 'done']) })).toMatchObject({ selection: { courses: [{ id: '42' }, { id: '43' }] } });
  const missing = await pickCourses([normalizeCanvasCourses([])], { version: 1, courses: [{ source: 'canvas', origin: 'https://canvas.lms.unimelb.edu.au', id: '99', term: { label: 'Course Term' } }] }, terminal(['done']));
  expect(missing).toMatchObject({ missing: [{ id: '99' }], selection: { courses: [] } });
});
it('selects matching Canvas and Ed course ids independently and displays Ed term groups', async () => {
  const { normalizeEdCourses } = await import('../../src/capture/discovery.js');
  const ed = normalizeEdCourses([1, 2].map(session => ({ course: { id: session === 2 ? 42 : 7, code: 'ABCD10001', name: 'Synthetic', year: 2026, session: `Semester ${session}`, status: 'active' } })));
  const term = terminal(['1', '3', 'done']);
  const picked = await pickCourses([discovery, ed], undefined, term);
  expect(picked).toMatchObject({ status: 'confirmed', selection: { courses: [{ source: 'canvas', id: '42' }, { source: 'ed', id: '42' }] } });
  const output = term.write.mock.calls.flat().join('\n');
  expect(output.indexOf('2026 Semester 2')).toBeLessThan(output.indexOf('2026 Semester 1'));
  expect(output).toContain('[ ] ed | 2026 Semester 1');
});
it('cancels on signal before discovery confirmation without altering storage', async () => {
  const controller = new AbortController();
  const store = { load: async () => ({ status: 'valid' as const, selection: prior }), save: vi.fn() };
  const discover = vi.fn(async () => { controller.abort(); return [discovery]; });
  expect(await resolveSelection({ isTTY: true, reselect: true, store, discover, terminal: terminal(['done']), signal: controller.signal })).toEqual({ status: 'cancelled' });
  expect(store.save).not.toHaveBeenCalled();
});
it('reports skipped Canvas rows without treating the source as unavailable', async () => {
  const term = terminal(['done']);
  await pickCourses([normalizeCanvasCourses([{ id: '42', name: 'Published', term: 'Course Term' }, { id: '', name: 'Unpublished', term: 'Course Term' }])], undefined, term);
  const output = term.write.mock.calls.flat().join('\n');
  expect(output).toContain('canvas: skipped 1 inaccessible course row(s).');
  expect(output).not.toContain('canvas unavailable');
});
