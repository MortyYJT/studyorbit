import { currentLinks, linkedSources, platformState } from '../store/platform-state.js';
import { AnnotationService } from '../protocol/annotations.js';
import { TrustedStoreEvidence } from '../protocol/reads.js';
import type { Task } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import type { Collection, QueryInput, QueryItem } from '../store/queries.js';
export interface WorkItem {
  workId: string; title: string; courseId?: string; due?: string;
  estimateMinutes?: number; estimateOrigin?: 'agent' | 'owner';
  agentEstimate?: { minutes: number; reason?: string }; actualMinutes: number;
}
export interface Deadline { workId: string; title: string; courseId?: string; due?: string; date?: string; kind: 'exam' | 'all-day' }
export function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)!.value).join('-');
}
function all<K extends Collection>(store: SqliteRepository, collection: K): QueryItem<K>[] {
  const items: QueryItem<K>[] = []; let cursor: string | undefined;
  do { const page = store.query(collection, { limit: 500, cursor } as QueryInput<K>); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return items;
}
/** Accepted breakdowns supersede legacy task copies with the same identity. */
export function planningTasks(store: SqliteRepository): Map<string, Task> {
  const tasks = new Map(all(store, 'tasks').map(task => [task.id, task]));
  for (const record of store.listStudyRecords('breakdown.write')) {
    if ('task' in record) tasks.set(record.task.id, record.task);
  }
  return tasks;
}
export function effectiveWork(store: SqliteRepository, item: WorkItem): WorkItem {
  const estimates = store.readEstimates(item.workId);
  const agent = estimates.filter(row => row.origin === 'agent').at(-1);
  const estimate = estimates.filter(row => row.origin === 'owner').at(-1) ?? (item.estimateOrigin === 'owner' && item.estimateMinutes !== undefined ? { minutes: item.estimateMinutes, origin: 'owner' as const } : agent);
  return { ...item, ...(estimate ? { estimateMinutes: estimate.minutes, estimateOrigin: estimate.origin } : {}),
    ...(agent ? { agentEstimate: { minutes: agent.minutes, reason: agent.reason } } : {}),
    actualMinutes: store.readTimeLogs(item.workId).reduce((total, row) => total + row.minutes, 0) };
}
export function collectWork(store: SqliteRepository, term: string, timeZone: string, annotations = new AnnotationService(store, new TrustedStoreEvidence(store))) {
  const courses = new Set(all(store, 'courses').filter(course => course.term === term).map(course => course.id));
  const items: WorkItem[] = []; const deadlines: Deadline[] = []; const active = new Map<string, WorkItem>();
  const links = currentLinks(store.listAssessmentLinks());
  for (const assessment of all(store, 'assessments')) {
    if (!courses.has(assessment.courseId)) continue;
    const platform = platformState(linkedSources(store, links, assessment.id));
    if (['submitted', 'graded'].includes(assessment.status) || platform.submitted || platform.removed) continue;
    const fields = annotations.read({ entity: 'assessment', entityId: assessment.id, limit: 0 }).fields;
    const due = fields.due!.value as string | undefined | null;
    const title = fields.name!.value as string | null;
    if (title === null) continue;
    const kind = fields.kind!.value;
    const base = { workId: assessment.id, title, courseId: assessment.courseId, due: due ?? undefined, actualMinutes: 0 };
    if (kind === 'exam') { deadlines.push({ workId: base.workId, title, courseId: base.courseId, due: due ?? undefined, kind: 'exam', ...(due ? { date: localDate(due, timeZone) } : {}) }); continue; }
    active.set(assessment.id, base); items.push(base);
  }
  for (const task of planningTasks(store).values()) {
    if (task.done || task.courseId && !courses.has(task.courseId) || task.assessmentId && !active.has(task.assessmentId)) continue;
    const due = task.due ?? (task.assessmentId ? active.get(task.assessmentId)?.due : undefined);
    const base = { workId: task.id, title: task.title, courseId: task.courseId, due, actualMinutes: 0 };
    if (task.source === 'manual') {
      if (task.steps.every(step => step.done)) continue;
      if (task.allDay) deadlines.push({ workId: base.workId, title: base.title, courseId: base.courseId, due, kind: 'all-day', date: localDate(due!, timeZone) });
      else {
        const minutes = task.steps.filter(step => !step.done).reduce((sum, step) => sum + step.estimateMinutes, 0);
        items.push({ ...base, ...(minutes > 0 ? { estimateMinutes: minutes, estimateOrigin: 'owner' as const } : {}) });
      }
    } else task.steps.forEach((step, index) => {
      if (!step.done) items.push({ ...base, workId: `${task.id}:step:${index}`, title: step.title });
    });
  }
  return { items: items.map(item => effectiveWork(store, item)).sort((a, b) => a.workId < b.workId ? -1 : a.workId > b.workId ? 1 : 0), deadlines };
}
