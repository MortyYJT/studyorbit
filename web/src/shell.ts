import { type Client, type Output, ClientError } from './client.js';
import { settingsInput } from '../../src/planning/contracts.js';
export type Settings = NonNullable<Output<'planning.settings.read'>['settings']>;
export type Site = 'canvas' | 'ed';
export interface ShellState {
  courses?: Output<'courses.list'>;
  tasks?: Output<'tasks.list'>;
  browser?: Output<'browser.status'>;
  sync?: Output<'sync.status'>;
  planning?: Output<'planning.settings.read'>;
  audit?: Output<'audit.list'>;
  syncing: boolean;
  saving: boolean;
  auditLoading: boolean;
  errors: Partial<Record<'courses' | 'tasks' | 'browser' | 'sync' | 'planning' | 'audit' | 'action', string>>;
}
const code = (error: unknown) => error instanceof ClientError ? error.code : 'SOURCE_UNAVAILABLE';
export function emptyStore(state: ShellState): boolean {
  return !!state.courses?.coverage.complete && !!state.tasks?.coverage.complete
    && !state.errors.courses && !state.errors.tasks && !state.courses.items.length && !state.tasks.items.length;
}
export function attention(state: ShellState): { site: Site; kind: 'signin' | 'sync' }[] {
  return (['canvas', 'ed'] as const).flatMap(site => {
    const items: { site: Site; kind: 'signin' | 'sync' }[] = [];
    if (state.browser?.[site].state === 'signedOut' || state.sync?.[site].lastRun?.status === 'AUTH_EXPIRED') items.push({ site, kind: 'signin' });
    const status = state.sync?.[site].lastRun?.status;
    if (status && status !== 'OK' && status !== 'AUTH_EXPIRED') items.push({ site, kind: 'sync' });
    return items;
  });
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
  private state: ShellState = { syncing: false, saving: false, auditLoading: false, errors: {} };
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
      ['courses', 'courses.list'], ['tasks', 'tasks.list'], ['browser', 'browser.status'],
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
