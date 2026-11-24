import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { migrateStoragePrefix } from '../web/src/storage-prefix.js';
import { migrateThemeChoice, previousThemeKey, readTheme, resolveTheme, saveThemeChoice, themeStorageKey, themes } from '../web/src/theme.js';

// A synthetic in-memory stand-in for the browser's localStorage.
function memoryStorage(initial: Record<string, string>, failOn: string[] = []) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    data, writes,
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failOn.includes(key)) throw new Error('quota'); writes.push(key); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

describe('resolveTheme', () => {
  it('follows the system when nothing was ever chosen', () => {
    expect(resolveTheme(null, null)).toBe('system');
  });

  it('keeps every explicit choice stored under the current key', () => {
    for (const theme of themes) expect(resolveTheme(theme, null)).toBe(theme);
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it('treats a light stored under the previous key as never chosen', () => {
    // The app used to write its default (`light`) back on every start, so that value says nothing about a choice.
    expect(resolveTheme(null, 'light')).toBe('system');
  });

  it('keeps dark and system stored under the previous key, which only a choice could have written', () => {
    expect(resolveTheme(null, 'dark')).toBe('dark');
    expect(resolveTheme(null, 'system')).toBe('system');
  });

  it('ignores unknown values under either key', () => {
    expect(resolveTheme('sepia', null)).toBe('system');
    expect(resolveTheme('sepia', 'dark')).toBe('dark');
    expect(resolveTheme(null, 'sepia')).toBe('system');
    expect(resolveTheme('', '')).toBe('system');
  });
});

describe('theme storage', () => {
  it('uses a versioned key next to the previous one', () => {
    expect(themeStorageKey).toBe('studyorbit.theme.v2');
    expect(previousThemeKey).toBe('studyorbit.theme');
  });

  it('keeps a dark still under the former prefix when the prefix move could not write', () => {
    // The pre-mount script falls back to `coursework.theme`; the app must read the same, or the page flips after mount.
    const storage = memoryStorage({ 'coursework.theme': 'dark' }, [previousThemeKey]);
    migrateStoragePrefix(storage);
    migrateThemeChoice(storage);
    expect(Object.fromEntries(storage.data)).toEqual({ 'coursework.theme': 'dark' });
    expect(readTheme(storage)).toBe('dark');
    // A value under the current prefix still wins over the former one, as in the prefix move.
    expect(readTheme(memoryStorage({ [previousThemeKey]: 'light', 'coursework.theme': 'dark' }))).toBe('system');
  });

  it('reads the theme without writing anything', () => {
    const storage = memoryStorage({ [previousThemeKey]: 'light' });
    expect(readTheme(storage)).toBe('system');
    expect(storage.writes).toEqual([]);
    expect(Object.fromEntries(storage.data)).toEqual({ [previousThemeKey]: 'light' });
  });

  it('saves an explicit choice, including system and light', () => {
    for (const theme of themes) {
      const storage = memoryStorage({});
      saveThemeChoice(storage, theme);
      expect(Object.fromEntries(storage.data)).toEqual({ [themeStorageKey]: theme });
      expect(readTheme(storage)).toBe(theme);
    }
  });

  it('keeps working in memory when the choice cannot be saved', () => {
    const storage = memoryStorage({}, [themeStorageKey]);
    expect(() => saveThemeChoice(storage, 'dark')).not.toThrow();
    expect(readTheme(storage)).toBe('system');
  });
});

describe('migrateThemeChoice', () => {
  it('drops a previous light and stores no default in its place', () => {
    const storage = memoryStorage({ [previousThemeKey]: 'light', 'studyorbit.palette': 'pine' });
    migrateThemeChoice(storage);
    expect(Object.fromEntries(storage.data)).toEqual({ 'studyorbit.palette': 'pine' });
    expect(readTheme(storage)).toBe('system');
  });

  it('moves a previous dark or system to the current key', () => {
    for (const theme of ['dark', 'system'] as const) {
      const storage = memoryStorage({ [previousThemeKey]: theme });
      migrateThemeChoice(storage);
      expect(Object.fromEntries(storage.data)).toEqual({ [themeStorageKey]: theme });
    }
  });

  it('keeps a choice already under the current key and drops the previous key', () => {
    const storage = memoryStorage({ [themeStorageKey]: 'light', [previousThemeKey]: 'dark' });
    migrateThemeChoice(storage);
    expect(Object.fromEntries(storage.data)).toEqual({ [themeStorageKey]: 'light' });
  });

  it('writes nothing on a browser that never stored a theme, and nothing the second time', () => {
    const fresh = memoryStorage({});
    migrateThemeChoice(fresh);
    expect(fresh.writes).toEqual([]);
    expect(fresh.data.size).toBe(0);
    const storage = memoryStorage({ [previousThemeKey]: 'dark' });
    migrateThemeChoice(storage);
    storage.writes.length = 0;
    migrateThemeChoice(storage);
    expect(storage.writes).toEqual([]);
    expect(Object.fromEntries(storage.data)).toEqual({ [themeStorageKey]: 'dark' });
  });

  it('keeps the previous dark when the current key cannot be written, so the choice survives', () => {
    const storage = memoryStorage({ [previousThemeKey]: 'dark' }, [themeStorageKey]);
    migrateThemeChoice(storage);
    expect(Object.fromEntries(storage.data)).toEqual({ [previousThemeKey]: 'dark' });
    expect(readTheme(storage)).toBe('dark');
  });

  it('never changes what the page shows', () => {
    const values = [null, 'light', 'dark', 'system', 'sepia', ''];
    for (const current of values) for (const previous of values) {
      const initial: Record<string, string> = {};
      if (current !== null) initial[themeStorageKey] = current;
      if (previous !== null) initial[previousThemeKey] = previous;
      const storage = memoryStorage(initial);
      const before = readTheme(storage);
      migrateThemeChoice(storage);
      expect(readTheme(storage), `current=${current} previous=${previous}`).toBe(before);
    }
  });
});

// The script in index.html runs before the bundle, so it cannot import theme.ts; these tests run the real script.
describe('the pre-mount script in index.html', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

  /** Runs the inline script against a fake storage and returns the `data-theme` it left on <html>. */
  function premountTheme(localStorage: unknown): string | undefined {
    const dataset: Record<string, string> = {};
    runInNewContext(script, { localStorage, document: { documentElement: { dataset, style: { setProperty() {} } } } });
    return dataset.theme;
  }

  it('is found in index.html', () => {
    expect(script).toContain(themeStorageKey);
  });

  it('applies the same theme as the app for every stored combination, before and after the storage moves', () => {
    const values = [null, 'light', 'dark', 'system', 'sepia', ''];
    // Each combination also runs with storage that refuses a write, so a move that stops half-way is covered too.
    const failures = [[], [previousThemeKey], [themeStorageKey], [previousThemeKey, themeStorageKey]];
    for (const failOn of failures) for (const current of values) for (const previous of values) for (const legacy of values) {
      const initial: Record<string, string> = {};
      if (current !== null) initial[themeStorageKey] = current;
      if (previous !== null) initial[previousThemeKey] = previous;
      if (legacy !== null) initial['coursework.theme'] = legacy;
      const label = `current=${current} previous=${previous} legacy=${legacy} failing writes=[${failOn.join(', ')}]`;
      const storage = memoryStorage(initial, failOn);
      const firstPaint = premountTheme(storage);
      // main.tsx: the prefix move, then the theme move, then App reads the theme.
      migrateStoragePrefix(storage);
      migrateThemeChoice(storage);
      expect(firstPaint, label).toBe(readTheme(storage));
      // The next load sees the moved storage and must paint the same theme.
      expect(premountTheme(storage), label).toBe(firstPaint);
    }
  });

  it('writes nothing', () => {
    const storage = memoryStorage({ [previousThemeKey]: 'light', 'coursework.theme': 'dark' });
    premountTheme(storage);
    expect(storage.writes).toEqual([]);
    expect(storage.data.size).toBe(2);
  });

  it('leaves the theme unset when storage is blocked, which the stylesheet treats as following the system', () => {
    const blocked = { getItem() { throw new Error('blocked'); } };
    expect(premountTheme(blocked)).toBeUndefined();
    expect(readTheme(blocked)).toBe('system');
  });
});

// "Follow the system" is pure CSS: every explicit dark rule has a twin inside `prefers-color-scheme: dark` that applies
// whenever <html> is neither light nor dark. The twins must stay identical, or the two dark modes drift apart.
describe('the system-dark rules in style.css', () => {
  const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8');
  const followsSystem = ':root:not([data-theme="light"]):not([data-theme="dark"])';
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

  it('mirror every explicit dark rule', () => {
    const explicit = [...css.matchAll(/^((?::root)?\[data-theme="dark"\][^{]*)\{([^}]*)\}/gm)]
      .map(match => [squash(match[1]!.replace(/(?::root)?\[data-theme="dark"\]/g, followsSystem)), squash(match[2]!)]);
    const system = [...css.matchAll(/^@media\(prefers-color-scheme:dark\) \{ ([^{]*)\{([^}]*)\} \}/gm)]
      .map(match => [squash(match[1]!), squash(match[2]!)]);
    expect(explicit.length).toBeGreaterThan(1);
    expect(system).toEqual(explicit);
    // A pair written in a form the two patterns above do not match (indented, or the media query on its own line)
    // must not slip through: every `prefers-color-scheme: dark` in the file is a matched twin, and every explicit
    // dark selector in the file sits in a matched rule.
    expect(css.match(/prefers-color-scheme\s*:\s*dark/g)?.length).toBe(system.length);
    const explicitSelectors = [...css.matchAll(/^((?::root)?\[data-theme="dark"\][^{]*)\{/gm)].reduce((count, match) => count + match[1]!.match(/\[data-theme="dark"\]/g)!.length, 0);
    expect(css.match(/(?<!:not\()\[data-theme="dark"\]/g)?.length).toBe(explicitSelectors);
    // No dark rule hides elsewhere in the file in a form the pattern above does not see.
    expect(css.match(/\[data-theme="dark"\]/g)?.length).toBe(css.match(/:not\(\[data-theme="dark"\]\)/g)!.length * 2);
  });
});
