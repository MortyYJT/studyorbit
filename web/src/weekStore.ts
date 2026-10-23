import { ClientError, type Client } from './client.js';
import type { PlanScope } from '../../src/planning/contracts.js';
import { localDate, mergePlanPages, mondayOf, pickTerm, type Assessment, type Confirmation, type Course, type Plan, type PlanPage, type Task } from './week.js';
// One plan anchored at the current Monday: navigation only shows slices of it, so
// reading another week never re-evaluates (and drops start times on) other dates.
export const HORIZON_DAYS = 366;
export const DEFAULT_TIME_ZONE = 'Australia/Melbourne'; // documented settings default
type ErrorKey = 'courses' | 'assessments' | 'tasks' | 'plan' | 'confirmations' | 'action';
export interface WeekState {
  courses?: Course[]; assessments?: Assessment[]; tasks?: Task[]; confirmations?: Confirmation[];
  plan?: Plan; scope?: PlanScope; term?: string; terms: string[]; timeZone: string; today?: string;
  busy: boolean; errors: Partial<Record<ErrorKey, string>>;
}
const code = (error: unknown) => error instanceof ClientError ? error.code : 'SOURCE_UNAVAILABLE';
const MAX_PAGES = 1000;
export type ManualFields = { title: string; due?: string; estimateMinutes?: number; allDay?: boolean };
export class WeekStore {
  private state: WeekState = { terms: [], timeZone: DEFAULT_TIME_ZONE, busy: false, errors: {} };
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  constructor(readonly client: Client, private readonly now: () => Date = () => new Date()) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: Partial<WeekState>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private setErrors(value: Partial<Record<ErrorKey, string | undefined>>) { this.update({ errors: { ...this.state.errors, ...value } }); }
  private async pages<T>(read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
    const items: T[] = []; let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) { const result = await read(cursor); items.push(...result.items); cursor = result.nextCursor; if (!cursor) return items; }
    throw new ClientError('LIMIT_EXCEEDED', 'Too many pages');
  }
  private async load<K extends 'courses' | 'assessments' | 'tasks' | 'confirmations', T>(key: K, read: () => Promise<T>): Promise<T | undefined> {
    try { const value = await read(); this.update({ [key]: value } as Partial<WeekState>); this.setErrors({ [key]: undefined }); return value; }
    catch (error) { this.setErrors({ [key]: code(error) }); return undefined; }
  }
  setTerm(term: string) { this.update({ term }); return this.refresh(); }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.read().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async read() {
    const [courses] = await Promise.all([
      this.load('courses', () => this.pages(cursor => this.client.call('courses.list', { limit: 500, ...(cursor ? { cursor } : {}) }))),
      this.load('assessments', () => this.pages(cursor => this.client.call('assessments.list', { limit: 500, ...(cursor ? { cursor } : {}) }))),
      this.load('tasks', () => this.pages(cursor => this.client.call('tasks.list', { limit: 500, ...(cursor ? { cursor } : {}) }))),
      this.client.hasSession() ? this.load('confirmations', () => this.pages(cursor => this.client.call('confirmation.list', { limit: 50, ...(cursor ? { cursor } : {}) }))) : undefined,
    ]);
    await this.readPlan(courses ?? this.state.courses ?? []);
  }
  private async readPlan(courses: Course[]) {
    const terms = [...new Set(courses.map(course => course.term))].sort();
    const term = this.state.term && terms.includes(this.state.term) ? this.state.term : pickTerm(courses);
    let timeZone = this.state.plan?.settings?.timeZone ?? this.state.timeZone;
    try { timeZone = (await this.client.call('planning.settings.read', {})).settings?.timeZone ?? DEFAULT_TIME_ZONE; } catch { /* Keep the last known zone. */ }
    const today = localDate(this.now(), timeZone);
    this.update({ terms, term, timeZone, today });
    if (!term) { this.update({ plan: undefined, scope: undefined }); this.setErrors({ plan: undefined }); return; }
    const scope: PlanScope = { term, startDate: mondayOf(today), horizonDays: HORIZON_DAYS };
    try {
      const pages: PlanPage[] = []; let cursor: string | undefined; let count = 0;
      do {
        if (++count > MAX_PAGES) throw new ClientError('LIMIT_EXCEEDED', 'Too many pages');
        const page = await this.client.call('plan.read', { ...scope, limit: 500, ...(cursor ? { cursor } : {}) });
        pages.push(page); cursor = page.nextCursor;
      } while (cursor);
      this.update({ plan: mergePlanPages(pages), scope }); this.setErrors({ plan: undefined });
    } catch (error) { this.update({ plan: undefined, scope }); this.setErrors({ plan: code(error) }); }
  }
  private async write(run: () => Promise<unknown>): Promise<boolean> {
    if (this.state.busy) return false;
    this.update({ busy: true }); this.setErrors({ action: undefined });
    try { await run(); await this.refresh(); return true; }
    catch (error) { this.setErrors({ action: code(error) }); return false; }
    finally { this.update({ busy: false }); }
  }
  setStart(workId: string, date: string, time: string) {
    const scope = this.state.scope;
    return this.write(() => { if (!scope) throw new ClientError('SOURCE_UNAVAILABLE', 'No plan'); return this.client.call('plan.start.set', { ...scope, workId, date, time }); });
  }
  clearStart(workId: string, date: string) { return this.write(() => this.client.call('plan.start.clear', { workId, date })); }
  recordTime(workId: string, minutes: number) { return this.write(() => this.client.call('time.record', { workId, minutes })); }
  createManual(moduleId: string, fields: ManualFields) { return this.write(() => this.client.call('manual.create', { moduleId, ...fields })); }
  editManual(id: string, fields: ManualFields) {
    const { due, ...rest } = fields;
    return this.write(() => this.client.call('manual.edit', { id, ...rest, due: due ?? null }));
  }
  completeManual(id: string) { return this.write(() => this.client.call('manual.complete', { id })); }
  deleteManual(id: string) { return this.write(() => this.client.call('manual.delete', { id })); }
}
