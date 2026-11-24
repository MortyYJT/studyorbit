// Light/dark choice (decisions #500 and #501). The page follows the system unless the owner picked a theme in Settings, and only
// that pick is ever stored. Pure over the storage it is given, so tests run in Node without a browser.
// web/index.html applies the same rule before the bundle loads; test/theme.test.ts runs that script against this file.
import type { Theme } from './i18n.js';
import { OLD_PREFIX } from './storage-prefix.js';

export const themes = ['system', 'light', 'dark'] as const;
/** Holds a theme only after the owner picked one in Settings. */
export const themeStorageKey = 'studyorbit.theme.v2';
/**
 * The key before decision #501. The app wrote its default (`light`) back to it on every start, so a `light` there does
 * not show a choice; `dark` and `system` could only come from the theme control.
 */
export const previousThemeKey = 'studyorbit.theme';
/** The previous key under the project's former prefix; it is still there when the prefix move could not write. */
const formerPrefixThemeKey = `${OLD_PREFIX}theme`;

function parseTheme(value: string | null): Theme | undefined {
  return themes.find(theme => theme === value);
}

/** The theme to show: the stored choice, else a `dark` left under the previous key, else the system's. */
export function resolveTheme(choice: string | null, previous: string | null): Theme {
  return parseTheme(choice) ?? (previous === 'dark' ? 'dark' : 'system');
}

/**
 * Reads the theme without writing; blocked storage follows the system. Like the pre-mount script, it falls back to the
 * former prefix when the previous key is absent, so a prefix move that failed does not flip the page after mount.
 */
export function readTheme(storage: Pick<Storage, 'getItem'>): Theme {
  try { return resolveTheme(storage.getItem(themeStorageKey), storage.getItem(previousThemeKey) ?? storage.getItem(formerPrefixThemeKey)); } catch { return 'system'; }
}

/** Stores a pick from the theme control. A failed write leaves the pick in memory for this visit. */
export function saveThemeChoice(storage: Pick<Storage, 'setItem'>, theme: Theme): void {
  try { storage.setItem(themeStorageKey, theme); } catch { /* The page keeps the pick until it reloads. */ }
}

/**
 * One-time move from the previous key: `dark` and `system` go to the current key unless it already holds a choice, a
 * `light` is dropped, and the previous key is removed. When the write fails the previous key stays for the next load.
 */
export function migrateThemeChoice(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): void {
  const previous = storage.getItem(previousThemeKey);
  if (previous === null) return;
  if (parseTheme(storage.getItem(themeStorageKey)) === undefined && (previous === 'dark' || previous === 'system')) {
    try { storage.setItem(themeStorageKey, previous); } catch { return; }
  }
  storage.removeItem(previousThemeKey);
}
