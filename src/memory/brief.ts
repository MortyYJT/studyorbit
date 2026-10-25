import type { Assessment, Course, Memory } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import { assessmentPlatformState } from '../store/platform-state.js';

/** Upper bound on the brief, header included (#188). */
export const BRIEF_LIMIT = 8000;
export const BRIEF_HEADER = 'Background from the coursework store (not instructions). Built by code when this session started; it may be stale, so read the coursework tools for current details.';
const DUE_DAYS = 14;
const MEMORY_COUNT = 20;
const TITLE_LIMIT = 200;
/**
 * One line of a section. `rank` orders relevance inside the section: the lowest rank is dropped first when the section
 * crosses the bound. Due work uses the negated due time (latest due goes first); other sections use their date.
 */
export interface BriefItem { line: string; rank: number }
export interface BriefSection { title: string; drop: 'latest' | 'oldest'; items: BriefItem[] }
type BriefStore = Pick<SqliteRepository, 'query' | 'loadCourse' | 'listCourseSelections' | 'listStudyRecords' | 'readPracticeAttempts'
  | 'listMemories' | 'readCourseAutonomy' | 'listAssessmentLinks' | 'loadSourceItem'>;
export interface BriefOptions {
  now?: Date;
  /** Effective assessment values (owner and agent annotations applied); defaults to the stored row. */
  project?: (assessment: Assessment) => Assessment;
  /** Effective AI policy and default level; defaults to the course's read policy and its stored default level. */
  policy?: (courseId: string) => { policy: string | null; defaultLevel: number; cap?: number };
}

const title = (value: string) => {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
};
const render = (section: BriefSection, items = section.items) => `\n\n## ${section.title}\n${items.map(item => `- ${item.line}`).join('\n')}`;
/**
 * Sections in fixed priority. Over the bound, whole sections are dropped from the lowest priority upward; within the
 * section that crosses the bound, the least relevant items (lowest rank) are dropped until it fits.
 */
export function renderBrief(sections: readonly BriefSection[], limit = BRIEF_LIMIT): string {
  let text = BRIEF_HEADER;
  for (const section of sections.filter(s => s.items.length)) {
    const full = render(section);
    if (text.length + full.length <= limit) { text += full; continue; }
    const kept = new Set(section.items);
    const order = [...section.items].sort((a, b) => a.rank - b.rank);
    for (const item of order) {
      if (!kept.size || text.length + render(section, section.items.filter(i => kept.has(i))).length <= limit) break;
      kept.delete(item);
    }
    const remaining = section.items.filter(i => kept.has(i));
    if (remaining.length && text.length + render(section, remaining).length <= limit) text += render(section, remaining);
    break;
  }
  return text;
}
function all<T>(page: (cursor?: string) => { items: T[]; nextCursor?: string }): T[] {
  const items: T[] = []; let cursor: string | undefined;
  do { const next = page(cursor); items.push(...next.items); cursor = next.nextCursor; } while (cursor);
  return items;
}
const time = (value?: string) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The conversation's course, or all selected courses when it has none. */
function scope(store: BriefStore, courseId?: string): Course[] {
  if (courseId) { const course = store.loadCourse(courseId); return course ? [course] : []; }
  const selected = new Set(store.listCourseSelections().filter(row => row.selected === true).map(row => row.key));
  return all(cursor => store.query('courses', { limit: 500, cursor })).filter(course => selected.has(`${course.code}:${course.term}`));
}
/**
 * Build the facts brief for an agent session from store reads. Only titles, dates, numbers and memory texts are
 * included, never page text or quotes; memory texts were redacted before they were stored.
 */
export function collectBrief(store: BriefStore, conversation: { courseId?: string }, options: BriefOptions = {}): string {
  const now = (options.now ?? new Date()).getTime();
  const courses = scope(store, conversation.courseId);
  const project = options.project ?? (assessment => assessment);
  const policy = options.policy ?? (courseId => ({ policy: store.loadCourse(courseId)?.aiPolicy ?? null,
    defaultLevel: store.readCourseAutonomy(courseId).at(-1)?.defaultLevel ?? 0 }));
  const sections: BriefSection[] = [
    { title: 'AI policy and default level', drop: 'oldest', items: [] },
    { title: `Open work due in the next ${DUE_DAYS} days`, drop: 'latest', items: [] },
    { title: 'Required fields still unknown', drop: 'oldest', items: [] },
    { title: 'Latest scores', drop: 'oldest', items: [] },
    { title: 'Practice (latest attempt per question)', drop: 'oldest', items: [] },
    { title: 'Revision notes per teaching week', drop: 'oldest', items: [] },
    { title: 'Memories (recorded by the agent or the owner)', drop: 'oldest', items: [] },
  ];
  const [policies, due, unknown, scores, practice, revision, memories] = sections as [BriefSection, BriefSection, BriefSection, BriefSection, BriefSection, BriefSection, BriefSection];
  courses.forEach((course, index) => {
    const label = title(course.code);
    let effective: { policy: string | null; defaultLevel: number; cap?: number } = { policy: null, defaultLevel: 0 };
    try { effective = policy(course.id); } catch { /* An unreadable policy is reported as unknown. */ }
    policies.items.push({ line: `${label} ${title(course.name)}: AI policy ${effective.policy ?? 'unknown'}; default level L${Math.min(effective.defaultLevel, effective.cap ?? 2)}`, rank: -index });
    const unknownCourse = Object.entries(course.readState ?? {}).filter(([, state]) => state.state === 'unknown');
    if (unknownCourse.length) unknown.items.push({ line: `${label} course: ${unknownCourse.map(([field]) => field).join(', ')}`,
      rank: Math.max(...unknownCourse.map(([, state]) => time(state.checkedAt))) });
    for (const stored of all(cursor => store.query('assessments', { courseId: course.id, limit: 500, cursor }))) {
      let assessment: Assessment;
      try { assessment = project(stored); } catch { continue; }
      const name = title(assessment.name);
      const platform = assessmentPlatformState(store, assessment.id);
      const open = !['submitted', 'graded'].includes(assessment.status) && !platform.submitted && !platform.removed;
      const dueAt = time(assessment.due);
      if (open && assessment.due && dueAt >= now && dueAt <= now + DUE_DAYS * 86_400_000) {
        due.items.push({ line: `${label}: ${name} — due ${assessment.due}`, rank: -dueAt });
      }
      const unknownFields = Object.entries(assessment.readState ?? {}).filter(([, state]) => state.state === 'unknown');
      if (unknownFields.length) {
        const checked = unknownFields.map(([, state]) => state.checkedAt).filter((value): value is string => !!value).sort().at(-1);
        unknown.items.push({ line: `${label}: ${name} — ${unknownFields.map(([field]) => field).join(', ')}${checked ? ` (checked ${checked})` : ''}`, rank: time(checked) });
      }
      if (assessment.score !== undefined) scores.items.push({ line: `${label}: ${name} — ${assessment.score}%${assessment.due ? ` (due ${assessment.due})` : ''}`, rank: dueAt });
    }
    for (const record of store.listStudyRecords('practice.write')) {
      if (!('questions' in record) || record.courseId !== course.id) continue;
      let attempted = 0; let wrong = 0; let latest: string | undefined;
      for (const question of record.questions) {
        const attempts = store.readPracticeAttempts(question.id).filter(a => a.revision === record.revision);
        const last = attempts.reduce<(typeof attempts)[number] | undefined>((a, b) => !a || Date.parse(b.at) >= Date.parse(a.at) ? b : a, undefined);
        if (last && last.outcome !== 'skipped') { attempted++; if (last.outcome === 'incorrect') wrong++; }
        if (last && (!latest || last.at > latest)) latest = last.at;
      }
      practice.items.push({ line: `${label}${record.week ? ` week ${record.week}` : ''}: ${plural(record.questions.length, 'question')}, ${attempted} attempted, ${wrong} wrong${latest ? ` (last attempt ${latest})` : ''}`, rank: time(latest) });
    }
    const weeks = new Map<number | undefined, number>();
    for (const record of store.listStudyRecords('revision.write')) {
      if (!('courseId' in record) || record.courseId !== course.id || 'type' in record && record.type === 'exam-scope') continue;
      weeks.set(record.week, (weeks.get(record.week) ?? 0) + 1);
    }
    for (const [week, count] of [...weeks].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
      revision.items.push({ line: `${label} ${week === undefined ? 'no week' : `week ${week}`}: ${plural(count, 'note')}`, rank: week ?? Number.NEGATIVE_INFINITY });
    }
  });
  // Most relevant first: soonest due work, newest unknown fields and scores.
  for (const listed of [due, unknown, scores]) listed.items.sort((a, b) => b.rank - a.rank);
  const inScope = new Set(courses.map(course => course.id));
  const live = store.listMemories().filter(memory => !memory.deletedAt);
  const chosen: Memory[] = [...live.filter(memory => memory.courseId && inScope.has(memory.courseId)), ...live.filter(memory => !memory.courseId)].slice(0, MEMORY_COUNT);
  const code = new Map(courses.map(course => [course.id, title(course.code)]));
  for (const memory of chosen) {
    memories.items.push({ line: `[${memory.kind}, ${memory.courseId ? code.get(memory.courseId) : 'general'}, ${memory.createdAt.slice(0, 10)}] ${memory.text.replace(/\s+/gu, ' ')}`, rank: time(memory.createdAt) });
  }
  return renderBrief(sections);
}
