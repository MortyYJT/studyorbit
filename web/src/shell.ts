import { type Client, type Output, ClientError } from './client.js';
import { settingsInput } from '../../src/planning/contracts.js';
import type { Copy } from './i18n.js';
export type Settings = NonNullable<Output<'planning.settings.read'>['settings']>;
export type Site = 'canvas' | 'ed';
export type Candidate = Output<'courses.candidates'>['items'][number];
type Policy = 'allowed' | 'prohibited' | 'owner-attested';
/** "Needs you" items the shell derives from the agent sync status (C-2); sign-in problems come only from the last run. */
type Warning = NonNullable<Output<'sync.status'>['courses'][number]['lastRun']>['warnings'][number];
export type FailedOutcome = 'FAILED' | 'TIMEOUT' | 'AGENT_UNAVAILABLE';
/** `blocked`: the last run's agent could not read the site (sign-in page or locked screen). */
export type Attention = { site: Site; kind: 'blocked' } | { kind: 'failed'; outcome: FailedOutcome } | { kind: 'select'; count: number }
  | { kind: 'unknown'; course: string; courseId?: string; fields: string[]; dropped: string[] }
  | { kind: 'weights'; course: string; courseId?: string; warning: Warning; sum?: number }
  | { kind: 'policy'; course: string; courseId?: string; value?: Policy; quote?: string }
  | { kind: 'unread'; course: string };
export interface ShellState {
  courses?: Output<'courses.list'>;
  candidates?: Candidate[];
  selecting: boolean;
  tasks?: Output<'tasks.list'>;
  sync?: Output<'sync.status'>;
  planning?: Output<'planning.settings.read'>;
  audit?: Output<'audit.list'>;
  syncing: boolean;
  saving: boolean;
  auditLoading: boolean;
  errors: Partial<Record<'courses' | 'tasks' | 'sync' | 'planning' | 'audit' | 'action' | 'candidates' | 'select', string>>;
}
const code = (error: unknown) => error instanceof ClientError ? error.code : 'SOURCE_UNAVAILABLE';
export function emptyStore(state: ShellState): boolean {
  return !!state.courses?.coverage.complete && !!state.tasks?.coverage.complete
    && !state.errors.courses && !state.errors.tasks && !state.courses.items.length && !state.tasks.items.length;
}
export function attention(state: ShellState): Attention[] {
  const outcome = state.sync?.lastRun?.outcome;
  const blocked = state.sync?.blocked ?? [];
  const allBlocked = outcome === 'AGENT_UNAVAILABLE' || blocked.length === 2;
  const sites = (['canvas', 'ed'] as const).flatMap((site): Attention[] => blocked.includes(site) ? [{ site, kind: 'blocked' }] : []);
  // A discovery with every platform blocked ends AGENT_UNAVAILABLE; the blocked items already say what to do.
  const failed: Attention[] = (outcome === 'FAILED' || outcome === 'TIMEOUT' || outcome === 'AGENT_UNAVAILABLE')
    && !(outcome === 'AGENT_UNAVAILABLE' && blocked.length > 0) ? [{ kind: 'failed', outcome }] : [];
  const courses = state.sync?.courses.flatMap(course => {
    const run = course.lastRun;
    if (!run) return [];
    const ids = course.courseId ? { courseId: course.courseId } : {};
    const items: Attention[] = [];
    if (run.unknownFields.length || run.dropped.length) items.push({ kind: 'unknown', course: course.code, ...ids, fields: run.unknownFields, dropped: run.dropped });
    for (const warning of run.warnings) items.push({ kind: 'weights', course: course.code, ...ids, warning,
      ...(warning === 'WEIGHT_SUM' && run.weightSum !== undefined ? { sum: run.weightSum } : {}) });
    if (run.policyChanged) {
      // The new value and its quote are the agent-read policy stored on the Course (#180).
      const stored = state.courses?.items.find(item => item.id === course.courseId);
      const quote = stored?.readState?.aiPolicy?.quote;
      items.push({ kind: 'policy', course: course.code, ...ids, ...(stored?.aiPolicy ? { value: stored.aiPolicy } : {}), ...(quote ? { quote } : {}) });
    }
    // A run blocked on every platform read no course; the blocked items already say why.
    if (!run.stored && !allBlocked) items.push({ kind: 'unread', course: course.code });
    return items;
  }) ?? [];
  // A NEEDS_SELECTION run keeps the entry while no course is selected (even after declining all), so it is never a dead end.
  const select = state.sync && (state.sync.undecided > 0 || outcome === 'NEEDS_SELECTION' && !state.sync.courses.length)
    ? [{ kind: 'select' as const, count: state.sync.undecided }] : [];
  return [...select, ...sites, ...failed, ...courses];
}
/** Contract path such as `components[1].items[0].due` in the owner's words (1-based positions). */
export function fieldName(path: string, t: Copy): string {
  const s = t.syncNeeds;
  return path.split('.').map(part => {
    const match = /^(components|items)\[(\d+)\]$/.exec(part);
    if (match) return (match[1] === 'components' ? s.component : s.item).join(String(Number(match[2]) + 1));
    return (s.fields as Record<string, string>)[part] ?? part;
  }).join(' · ');
}
export interface SelectionRow { key: string; code: string; name?: string; term: string; undecided: boolean; checked: boolean }
/** Undecided candidates first (unticked), then earlier decisions as recorded, so saving can also change them. */
export function selectionRows(candidates: readonly Candidate[]): SelectionRow[] {
  const row = (item: Candidate): SelectionRow => ({ key: item.key, code: item.code, ...(item.name ? { name: item.name } : {}), term: item.term,
    undecided: item.selected === undefined, checked: item.selected === true });
  return [...candidates.filter(item => item.selected === undefined), ...candidates.filter(item => item.selected !== undefined)].map(row);
}
export function settingsFromForm(previous: Settings | undefined, hours: string[], timeZone: string, anchor: string, breaks: string): Settings {
  const weekdayMinutes = hours.map(value => {
    const number = Number(value);
    const minutes = Math.round(number * 60);
    // Decimal hours and stored minutes can round-trip through binary floats.
    if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 24 || Math.abs(number * 60 - minutes) > 1e-8) throw new Error('Invalid hours');
    return minutes;
  });
  return settingsInput.parse({ timeZone, weekdayMinutes,
    teachingWeekAnchor: previous?.teachingWeekAnchor ?? anchor,
    breakWeeks: previous?.breakWeeks ?? (breaks.trim() ? breaks.split(',').map(value => Number(value.trim())) : []),
  });
}
export class ShellStore {
  private state: ShellState = { syncing: false, selecting: false, saving: false, auditLoading: false, errors: {} };
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  constructor(readonly client: Client) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: Partial<ShellState>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private error(key: keyof ShellState['errors'], value?: string) { this.update({ errors: { ...this.state.errors, [key]: value } }); }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readStatus().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async readStatus() {
    await Promise.all(([
      ['courses', 'courses.list'], ['tasks', 'tasks.list'],
      ['sync', 'sync.status'], ['planning', 'planning.settings.read'],
    ] as const).map(async ([key, command]) => {
      try { const data = await this.client.call(command, {}); this.update({ [key]: data }); this.error(key); }
      catch (error) { this.error(key, code(error)); }
    }));
  }
  async sync() {
    if (this.state.syncing || this.state.sync?.running) return;
    this.update({ syncing: true }); this.error('action');
    try { await this.client.call('sync.run', {}); }
    catch (error) { this.error('action', code(error)); }
    finally { await this.refresh(); this.update({ syncing: false }); }
  }
  async loadCandidates() {
    this.error('candidates');
    try { this.update({ candidates: (await this.client.call('courses.candidates', {})).items }); }
    catch (error) { this.error('candidates', code(error)); }
  }
  /** Records every listed course as ticked or not through the owner session, then re-reads status and candidates. */
  async selectCourses(rows: readonly SelectionRow[], checked: ReadonlySet<string>): Promise<boolean> {
    if (this.state.selecting || !rows.length) return false;
    this.update({ selecting: true }); this.error('select');
    try {
      // Only undecided rows and changed decisions are written, at most 100 per call (the contract's bound).
      const selections = rows.filter(row => row.undecided || row.checked !== checked.has(row.key)).map(row => ({ key: row.key, selected: checked.has(row.key) }));
      for (let start = 0; start < selections.length; start += 100) await this.client.call('courses.select', { selections: selections.slice(start, start + 100) });
      await Promise.all([this.refresh(), this.loadCandidates()]);
      return true;
    } catch (error) { this.error('select', code(error)); return false; }
    finally { this.update({ selecting: false }); }
  }
  async saveSettings(settings: Settings) {
    if (this.state.saving) return false;
    this.update({ saving: true }); this.error('action');
    try { await this.client.call('planning.settings.set', settings); this.update({ planning: { settings } }); return true; }
    catch (error) { this.error('action', code(error)); return false; }
    finally { this.update({ saving: false }); }
  }
  async loadAudit(more = false) {
    if (this.state.auditLoading || more && !this.state.audit?.nextCursor) return;
    this.update({ auditLoading: true }); this.error('audit');
    try {
      const audit = await this.client.call('audit.list', { ...(more ? { cursor: this.state.audit?.nextCursor } : {}), limit: 100 });
      this.update({ audit: { ...audit, items: [...(more ? this.state.audit?.items ?? [] : []), ...audit.items] } });
    } catch (error) { this.error('audit', code(error)); }
    finally { this.update({ auditLoading: false }); }
  }
}
