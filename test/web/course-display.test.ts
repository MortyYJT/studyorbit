import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assessmentGroups } from '../../web/src/course.js';
// The root test tsconfig has no JSX setting; Vite loads the view at runtime.
const viewPath = '../../web/src/CoursePage.js';
const { CoursePage } = await import(viewPath);
import { en } from '../../web/src/i18n.js';
import type { CourseState } from '../../web/src/course-store.js';
import type { Client } from '../../web/src/client.js';

vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => CourseState) => getSnapshot(),
}));
const fixture = vi.hoisted(() => ({ state: {} as CourseState }));
vi.mock('../../web/src/course-store.js', () => ({ CourseStore: class {
  constructor(readonly client: Client) {}
  subscribe = () => () => {};
  getSnapshot = () => fixture.state;
} }));
const item = (id: string, kind?: 'participation' | 'quiz' | 'assignment' | 'exam', due?: string, weight: number | undefined = 10) => ({
  id, courseId: 'c', name: id, kind, due, weight, isFinal: kind === 'exam', status: 'not_started' as const,
});
const grouped = (id: string, kind?: 'participation' | 'quiz' | 'assignment' | 'exam', due?: string) => ({
  ...item(id, kind, due), group: { key: id, name: id, weight: 10 },
});

it('orders components by kind then due time, and items by actual due instant with undated last', () => {
  const quiz = { key: 'quiz', name: 'Quizzes', weight: 20 };
  const items = [grouped('unknown'), grouped('undated-quiz', 'quiz'), grouped('exam', 'exam'), grouped('assignment', 'assignment'),
    { ...item('undated', 'quiz'), group: quiz },
    { ...item('offset-later', 'quiz', '2026-04-01T01:00:00Z'), group: quiz },
    { ...item('later', 'quiz', '2026-05-01T00:00:00Z'), group: quiz },
    { ...item('earlier', 'quiz', '2026-04-01T11:00:00+11:00'), group: quiz },
    grouped('participation', 'participation'), grouped('early-quiz', 'quiz', '2026-03-01T00:00:00Z')];
  expect(assessmentGroups(items).map(group => [group.key, group.items.map(row => row.id)])).toEqual([
    ['participation', ['participation']], ['early-quiz', ['early-quiz']], ['quiz', ['earlier', 'offset-later', 'later', 'undated']], ['undated-quiz', ['undated-quiz']],
    ['assignment', ['assignment']], ['exam', ['exam']], ['unknown', ['unknown']],
  ]);
  expect(items[0]!.id).toBe('unknown');
});

it('orders ungrouped items by kind and keeps a mixed component at its first item kind', () => {
  const mixed = { key: 'mixed', name: 'Mixed', weight: 20 };
  expect(assessmentGroups([item('exam', 'exam'), { ...item('mixed-quiz', 'quiz'), group: mixed },
    { ...item('mixed-ongoing', 'participation', '2026-01-01T00:00:00Z'), group: mixed }, item('participation', 'participation')])
    .flatMap(group => group.items.map(row => row.id))).toEqual(['participation', 'mixed-ongoing', 'mixed-quiz', 'exam']);
});

function page(items: CourseState['assessments']) {
  fixture.state = { course: { id: 'c', moduleId: 'm', code: 'SYNA10001', name: 'Synthetic', term: '2026-S2', assessmentsComplete: true },
    assessments: items, complete: true, details: {}, tasks: {}, sources: {}, recorded: {}, errors: {} };
  return renderToStaticMarkup(createElement(CoursePage, { courseId: 'c', client: { hasSession: () => false } as Client,
    t: en, language: 'en', onBack: () => {}, openAgent: () => {} }));
}

it('collects only effective zero weights in one native collapsed section after marked work', () => {
  const html = page([{ ...item('attendance', 'participation', undefined, 0), group: { key: 'attendance', name: 'Attendance', weight: 10 } }, item('essay', 'assignment'),
    { ...item('unknown-weight', 'quiz'), weight: undefined }, item('feedback', 'assignment', undefined, 0)]);
  expect(html.match(/<details/g)).toHaveLength(1);
  expect(html).toContain('<details class="no-marks">');
  expect(html).not.toMatch(/<details[^>]*\bopen(?:[ =>])/);
  const folded = html.slice(html.indexOf('<details'));
  expect(folded).toContain('attendance');
  expect(folded).toContain('feedback');
  expect(folded).not.toContain('unknown-weight');
  expect(html.indexOf('essay')).toBeLessThan(html.indexOf('<details'));
  expect(html.indexOf('unknown-weight')).toBeLessThan(html.indexOf('<details'));
});

it('maps all non-earned ring segments to white with a two-entry legend and a recessed track', () => {
  const html = page([{ ...item('graded', 'quiz', undefined, 20), score: 80, status: 'graded' },
    item('ungraded', 'assignment', undefined, 30), { ...item('unknown'), weight: undefined }]);
  expect(html).not.toContain('<details');
  expect(html).toContain('class="earned"');
  expect(html).toContain('class="not-earned"');
  expect(html).not.toMatch(/class="(?:lost|ungraded|unknown)" d=/);
  expect(html).toContain('Not earned');
  expect(html).not.toContain('Not graded yet');
  const css = readFileSync(new URL('../../web/src/style.css', import.meta.url), 'utf8');
  expect(css).toMatch(/--ring-earned:\s*#facc15/);
  expect(css).toContain('.donut .earned { stroke:var(--ring-earned); }');
  expect(css).toContain('.donut .not-earned { stroke:var(--ring-rest); }');
  expect(css).toMatch(/--ring-rest:\s*#fff\b/);
  expect(css).toMatch(/\.donut \.track\s*\{[^}]*stroke-width:\s*22/);
});

it('shows 4/5 · 80% from linked platform facts', () => {
  const html = page([{ ...item('graded', 'quiz'), score: 80, status: 'graded',
    platform: { linked: true, submitted: true, removed: false, pointsEarned: 4, pointsPossible: 5 } }]);
  expect(html).toContain('4/5 · 80%');
});

it('shows percentage alone when either or both points are missing, without inferring points', () => {
  for (const points of [{}, { pointsEarned: 4 }, { pointsPossible: 5 }]) {
    const html = page([{ ...item('graded', 'quiz'), score: 80, status: 'graded',
      platform: { linked: true, submitted: true, removed: false, ...points } }]);
    expect(html).toContain('<span class="num points">80%</span>');
    expect(html).not.toContain('/5');
    expect(html).not.toContain('4/');
  }
});
