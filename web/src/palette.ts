// The palette picker is gone (decision #511): the page has one set of colours, Codex's, in style.css. All that is left
// here is the clean-up of what the picker stored. Pure over the storage it is given, so tests run in Node.
import { NEW_PREFIX, OLD_PREFIX } from './storage-prefix.js';

/** Where the picker kept its choice: the current key, and the same key under the project's former prefix. */
export const formerPaletteKeys = [`${NEW_PREFIX}palette`, `${OLD_PREFIX}palette`] as const;

/**
 * Removes a stored palette id. Nothing reads it any more, and the app used to write its default (`mono`) back on every
 * start, so the value never showed a choice anyway. A later palette feature must use a new key.
 */
export function migratePaletteChoice(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of formerPaletteKeys) storage.removeItem(key);
}
