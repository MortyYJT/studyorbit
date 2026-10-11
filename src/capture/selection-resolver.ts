import type { DiscoveryResult, SelectedCourse } from './discovery.js';
import { pickCourses, type SelectionTerminal } from './picker.js';
import type { CaptureSelection, SelectionPersistence } from './selection-store.js';
import { fail, type FailureEnvelope } from '../protocol/envelope.js';
export interface SelectionResolverOptions {
  isTTY: boolean; reselect?: boolean; store: SelectionPersistence;
  discover: () => Promise<DiscoveryResult[]>; terminal?: SelectionTerminal; signal?: AbortSignal;
}
export type SelectionResolution = { status: 'ready'; selection: CaptureSelection; discovery?: DiscoveryResult[]; gaps: DiscoveryResult[]; missing: SelectedCourse[] }
  | { status: 'cancelled' } | { status: 'error'; envelope: FailureEnvelope };
export async function resolveSelection(options: SelectionResolverOptions): Promise<SelectionResolution> {
  const loaded = await options.store.load();
  if (!options.isTTY && (options.reselect || loaded.status !== 'valid')) return {
    status: 'error', envelope: fail('capture', 'INVALID_INPUT', 'Manual course selection is required.',
      'Run coursework capture --reselect in a terminal to select courses manually.'),
  };
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (loaded.status === 'valid' && !options.reselect) return { status: 'ready', selection: loaded.selection, gaps: [], missing: [] };
  if (!options.terminal) throw new Error('Selection terminal required.');
  const discovery = await options.discover();
  const picked = await pickCourses(discovery, loaded.status === 'valid' ? loaded.selection : undefined, options.terminal, options.signal);
  if (picked.status === 'cancelled') return picked;
  await options.store.save(picked.selection);
  return { status: 'ready', selection: picked.selection, discovery, gaps: picked.gaps, missing: picked.missing };
}
