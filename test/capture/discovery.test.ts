import { describe, it, expect } from 'vitest';
import { normalizeCanvasCourses, normalizeEdCourses } from '../../src/capture/discovery.js';
const course = (id: number, session: string, status = 'active') => ({ course: { id, code: 'ABCD10001', name: 'Synthetic course', year: 2026, session, status }, role: 'student', lab: null, last_active: null });
describe('normalized discovery', () => {
  it('lists active Ed terms newest first, independently from Canvas', () => {
    const ed = normalizeEdCourses([course(1, 'Semester 1'), course(2, 'Semester 2'), course(3, 'Semester 2', 'archived')]);
    expect(ed.status).toBe('available');
    if (ed.status !== 'available') return;
    expect(ed.courses.map(c => c.id)).toEqual(['2', '1']);
    expect(ed.courses[0].term.label).toBe('2026 Semester 2');
    const canvas = normalizeCanvasCourses([{ id: '2', name: 'Community', term: '默认学期' }]);
    expect(canvas.status).toBe('available');
    expect(ed.courses[0].source).toBe('ed');
  });
  it('refuses unknown Canvas evidence and malformed Ed data', () => {
    expect(normalizeCanvasCourses(null).status).toBe('unavailable');
    expect(normalizeEdCourses([{ course: { id: 1, status: 'active' } }]).status).toBe('unavailable');
    expect(normalizeCanvasCourses([]).status).toBe('available');
  });
});
it('keeps Canvas available and counts unpublished or linkless rows as skipped', () => {
  const result = normalizeCanvasCourses([
    { id: '42', name: 'Published', term: '2026 Semester 2' },
    { id: '', name: 'Unpublished', term: '2026 Semester 2', unpublished: true },
    { id: '43', name: 'Unpublished with link', term: 'Course Term', unpublished: true },
    { id: '', name: 'Linkless', term: 'Course Term' },
  ]);
  expect(result).toMatchObject({ status: 'available', skipped: 3, courses: [{ id: '42' }] });
  expect(normalizeCanvasCourses([])).toEqual({ source: 'canvas', status: 'available', skipped: 0, courses: [] });
});
