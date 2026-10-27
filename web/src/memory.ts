import { ClientError, type Client, type Output } from './client.js';
export type MemoryView = Output<'memory.list'>['items'][number];
export type MemoryKind = MemoryView['kind'];
export interface MemoryState { items?: MemoryView[]; nextCursor?: string; loading: boolean; saving: boolean; error?: string }
/** Owner memory panel state. Failed mutations retain the last visible list and the editor's draft. */
export class MemoryStore {
  private state: MemoryState = { loading: false, saving: false };
  private listeners = new Set<() => void>();
  constructor(readonly client: Client) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<MemoryState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private fail(error: unknown) { this.update({ error: error instanceof ClientError ? error.code : 'SOURCE_UNAVAILABLE' }); }
  async load(more = false) {
    if (this.state.loading) return;
    const cursor = more ? this.state.nextCursor : undefined;
    if (more && !cursor) return;
    this.update({ loading: true, error: undefined });
    try {
      const page = await this.client.call('memory.list', { ...(cursor ? { cursor } : {}) });
      this.update({ items: [...(cursor ? this.state.items ?? [] : []), ...page.items], nextCursor: page.nextCursor });
    } catch (error) { this.fail(error); } finally { this.update({ loading: false }); }
  }
  private async write(work: () => Promise<unknown>): Promise<boolean> {
    if (this.state.saving || this.state.loading) return false;
    this.update({ saving: true, error: undefined });
    try { await work(); await this.load(); return !this.state.error; }
    catch (error) { this.fail(error); return false; }
    finally { this.update({ saving: false }); }
  }
  add(input: { text: string; kind: MemoryKind; courseId?: string }) { return this.write(() => this.client.call('memory.add', input)); }
  edit(id: string, text: string, kind: MemoryKind) { return this.write(() => this.client.call('memory.edit', { id, text, kind })); }
  remove(id: string) { return this.write(() => this.client.call('memory.delete', { id })); }
}
