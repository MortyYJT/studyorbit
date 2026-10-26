import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
// The root test tsconfig has no JSX setting; Vite loads the view at runtime.
const viewPath = '../../web/src/WeekView.js';
const { NeedsYou } = await import(viewPath);
import { en } from '../../web/src/i18n.js';
import type { Need } from '../../web/src/week.js';

const props = { t: en, onStatus: () => {}, onSelect: () => {}, onCourse: () => {}, onResolve: () => {}, onOpenUpdate: () => {} };

it('renders both weight values and their buttons, the unmatched picker and dismiss, and the content-updated file action', () => {
  const needs: Need[] = [
    { kind: 'weight', id: 'w1', courseId: 'c1', componentName: 'Assignments', handbook: 30, canvas: 40 },
    { kind: 'unmatched', id: 'u1', courseId: 'c1', canvasName: 'Synthetic unlisted reflection', components: [{ key: 'c1:assignments', name: 'Assignments' }] },
    { kind: 'update', savedFileId: 'f1', courseId: 'c1', assessmentId: 'a1', assessmentName: 'Synthetic Essay', name: 'instructions.html', savedAt: '2026-10-24T00:00:00Z' },
  ];
  const html = renderToStaticMarkup(createElement(NeedsYou, { ...props, needs }));
  expect(html).toContain('Assignments · Handbook: 30% · Canvas: 40%');
  expect(html).toContain('Use Handbook');
  expect(html).toContain('Use Canvas');
  expect(html).toContain('Synthetic unlisted reflection');
  expect(html).toContain('Assign to component');
  expect(html).toContain('Dismiss');
  expect(html).toContain('Synthetic Essay · Assessment content updated · instructions.html');
  expect(html).toContain('Open file');
});

it('shows the first three of a long kind and a "show N more" toggle', () => {
  const weights: Need[] = Array.from({ length: 5 }, (_, index) => ({ kind: 'weights', course: `SYN${index}000${index}`, warning: 'WEIGHT_SUM', sum: 90 }));
  const html = renderToStaticMarkup(createElement(NeedsYou, { ...props, needs: weights }));
  expect(html).toContain('SYN00000');
  expect(html).toContain('SYN10001');
  expect(html).toContain('SYN20002');
  expect(html).not.toContain('SYN30003');
  expect(html).not.toContain('SYN40004');
  expect(html).toContain('Show 2 more');
});
