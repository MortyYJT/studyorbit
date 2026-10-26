/** Synthetic course documents for the agent course-reading contract; every value is invented. */
export const now = '2026-10-24T01:00:00Z';
export const canvasCourse = 'https://canvas.lms.unimelb.edu.au/courses/900001';
export const edCourse = 'https://edstem.org/au/courses/800001';
const syllabus = `${canvasCourse}/assignments/syllabus`;

export const apiSource = 'https://canvas.lms.unimelb.edu.au/api/v1/courses/900001/assignment_groups?include[]=assignments';
export const handbookAssessment = 'https://handbook.unimelb.edu.au/2026/subjects/syna10001/assessment';
export const kinds = ['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded'] as const;

export const found = (value: unknown, extra: Record<string, unknown> = {}) => ({ value, state: 'found', via: 'ax', ...extra });
export const quoted = (value: unknown, quote = 'Synthetic quoted text', source = syllabus) => found(value, { quote, source });
/** A Canvas API value: `via: "api"`, the API URL as source, no quote. */
export const api = (value: unknown, extra: Record<string, unknown> = {}) => found(value, { via: 'api', source: apiSource, ...extra });
/** A Handbook value: `via: "handbook"`, the assessment page URL as source, with a quote. */
export const handbook = (value: unknown, quote = 'Synthetic handbook text', extra: Record<string, unknown> = {}) =>
  found(value, { via: 'handbook', quote, source: handbookAssessment, ...extra });
export const unknown = (checkedAt = now) => ({ value: null, state: 'unknown', checkedAt });
export const notApplicable = () => ({ value: null, state: 'not_applicable' });

type Json = Record<string, any>;
export function item(id: number, overrides: Json = {}, code = 'SYNA10001', platform: 'canvas' | 'ed' = 'canvas'): Json {
  const url = platform === 'canvas' ? `${canvasCourse}/assignments/${id}` : `${edCourse}/lessons/${id}`;
  return { key: `${code}:${platform}:assignment:${id}`, name: found(`Synthetic item ${id}`), url,
    due: quoted('2026-10-30T12:59:00Z', `Due 31 October`, url), status: found('not_started'),
    score: notApplicable(), outOf: found(10), weight: unknown(), ...overrides };
}
export function component(slug: string, weight: number | null, items: Json[] = [], overrides: Json = {}, code = 'SYNA10001'): Json {
  return { key: `${code}:${slug}`, name: found(`Synthetic ${slug.replace(/-/g, ' ')}`), kind: found('assignment'),
    count: found(items.length), weight: weight === null ? unknown() : quoted(weight, `${slug} ${weight}%`), isFinal: found(false),
    hurdleMin: notApplicable(), items, ...overrides };
}
export function document(components: Json[] = [component('assignments', 60, [item(1)]), component('final-exam', 40, [], { kind: found('exam'), isFinal: found(true), count: found(1) })],
  course: Json = {}, code = 'SYNA10001', term = '2026:S2'): Json {
  return { course: { code: found(code), name: found('Synthetic Systems'), term: found(term),
    pages: { canvas: canvasCourse, ed: edCourse }, aiPolicy: unknown(), platforms: { canvas: 'read', ed: 'read' },
    componentsComplete: true, ...course }, components };
}
