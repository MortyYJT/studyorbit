import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { smallestDifference } from './colour-math.js';
import { modes, pairContrast, pairs, quietPairs, readTokens, weightTokens } from './palette-tokens.js';
import { formerPaletteKeys, migratePaletteChoice } from '../web/src/palette.js';
import { migrateStoragePrefix } from '../web/src/storage-prefix.js';
import { migrateThemeChoice, readTheme } from '../web/src/theme.js';

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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The five palettes are gone (decision #511): the page has one set of colours, so a stored palette id names nothing.
describe('migratePaletteChoice', () => {
  it('names the key the palette picker wrote and the same key under the former prefix', () => {
    expect(formerPaletteKeys).toEqual(['studyorbit.palette', 'coursework.palette']);
  });

  it('removes a stored palette, whichever one it was, and leaves everything else', () => {
    for (const palette of ['mono', 'mist', 'pine', 'stone', 'morty', 'violet', '']) {
      const storage = memoryStorage({ 'studyorbit.palette': palette, 'studyorbit.language': 'en', 'studyorbit.theme.v2': 'dark' });
      migratePaletteChoice(storage);
      expect(Object.fromEntries(storage.data), palette).toEqual({ 'studyorbit.language': 'en', 'studyorbit.theme.v2': 'dark' });
      expect(storage.writes).toEqual([]);
    }
  });

  it('removes a palette still under the former prefix, with or without the prefix move', () => {
    const moved = memoryStorage({ 'coursework.palette': 'pine' });
    migrateStoragePrefix(moved);
    migratePaletteChoice(moved);
    expect(moved.data.size).toBe(0);
    // The prefix move could not write, so the old key is still there.
    const stuck = memoryStorage({ 'coursework.palette': 'pine' }, ['studyorbit.palette']);
    migrateStoragePrefix(stuck);
    migratePaletteChoice(stuck);
    expect(stuck.data.size).toBe(0);
  });

  it('does nothing on a browser that never stored a palette, and nothing the second time', () => {
    const storage = memoryStorage({ 'studyorbit.language': 'zh' });
    migratePaletteChoice(storage);
    migratePaletteChoice(storage);
    expect(Object.fromEntries(storage.data)).toEqual({ 'studyorbit.language': 'zh' });
    expect(storage.writes).toEqual([]);
  });
});

// The script in index.html runs before the bundle; these tests run the real script, as test/theme.test.ts does.
describe('the pre-mount script in index.html and a stored palette', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(read('../web/index.html'))?.[1] ?? '';

  function premount(localStorage: unknown): Record<string, string> {
    const dataset: Record<string, string> = {};
    runInNewContext(script, { localStorage, document: { documentElement: { dataset, style: { setProperty() {} } } } });
    return dataset;
  }

  it('paints the same page whatever palette was stored, before and after the storage moves', () => {
    const values = [null, 'mono', 'mist', 'pine', 'stone', 'morty', 'violet', ''];
    const themes: Record<string, string>[] = [{}, { 'studyorbit.theme.v2': 'dark' }, { 'studyorbit.theme': 'dark' }, { 'studyorbit.theme.v2': 'light' }];
    // Also with storage that refuses the prefix move's write, so a move that stops half-way is covered.
    for (const failOn of [[], ['studyorbit.palette']]) for (const theme of themes) for (const current of values) for (const legacy of values) {
      const initial: Record<string, string> = { ...theme };
      if (current !== null) initial['studyorbit.palette'] = current;
      if (legacy !== null) initial['coursework.palette'] = legacy;
      const label = `current=${current} legacy=${legacy} theme=${JSON.stringify(theme)} failing writes=[${failOn.join(', ')}]`;
      const storage = memoryStorage(initial, failOn);
      const untouched = premount(memoryStorage({ ...theme }));
      const firstPaint = premount(storage);
      expect(firstPaint, label).toEqual(untouched);
      expect('palette' in firstPaint, label).toBe(false);
      // main.tsx: the prefix move, the theme move, then the palette clean-up; App reads the theme.
      migrateStoragePrefix(storage);
      migrateThemeChoice(storage);
      migratePaletteChoice(storage);
      expect(firstPaint.theme, label).toBe(readTheme(storage));
      expect([...storage.data.keys()].filter(key => key.endsWith('.palette')), label).toEqual([]);
      expect(premount(storage), label).toEqual(firstPaint);
    }
  });

  it('never reads or sets a palette', () => {
    expect(script).not.toMatch(/palette/i);
    for (const path of ['../web/src/style.css', '../web/src/App.tsx']) expect(read(path), path).not.toMatch(/data-palette|dataset\.palette/);
  });
});

describe('the colour tokens in style.css', () => {
  const tokens = readTokens();

  it('are each written once, so light and dark cannot drift apart in a second rule', () => {
    // readTokens throws on a second declaration; the names the page relies on are all there.
    for (const name of ['sidebar', 'ground', 'surface', 'float', 'field', 'raised', 'hover', 'active', 'rule', 'border', 'border-strong',
      'text', 'muted', 'faint', 'accent', 'accent-hover', 'on-accent', 'focus', 'selection', 'signal', 'track', 'tint', 'scrim', ...weightTokens]) {
      expect(tokens[name], name).toBeDefined();
    }
    // A colour token outside light-dark() would be the same in both themes; only none are meant to be.
    const css = read('../web/src/style.css');
    expect(css.match(/(?<![\w-])--[a-z][a-z0-9-]*\s*:\s*(?:#|rgb\()/g) ?? []).toEqual([]);
  });

  it('refuse a token that is declared twice', () => {
    expect(() => readTokens(':root { --text:light-dark(#111, #eee); }\n[data-theme="dark"] { --text:#fff; }')).toThrow(/--text is declared more than once/);
  });

  it('keep every text, mark and edge the page draws at its WCAG floor, light and dark', () => {
    const failures: string[] = [];
    for (const mode of modes) for (const pair of pairs) {
      const ratio = pairContrast(tokens, mode, pair);
      if (ratio < pair.floor) failures.push(`${mode}: ${pair.what} (--${pair.ink} on ${pair.on.join(' + ')}) is ${ratio.toFixed(2)}:1, under ${pair.floor}:1`);
    }
    expect(failures).toEqual([]);
  });

  it('keep the unfilled part of the ring and the weight bar visible', () => {
    for (const mode of modes) for (const pair of quietPairs) expect(pairContrast(tokens, mode, pair), `${mode}: ${pair.what}`).toBeGreaterThanOrEqual(pair.floor);
  });

  it('keep the six weight colours apart from each other, from the alert red and from the ink', () => {
    for (const mode of modes) {
      const colours = weightTokens.map(name => tokens[name]![mode]);
      expect(smallestDifference(colours).value, `${mode}, normal vision`).toBeGreaterThanOrEqual(25);
      expect(smallestDifference(colours, 'deuteranopia').value, `${mode}, deuteranopia`).toBeGreaterThanOrEqual(12);
      expect(smallestDifference(colours, 'protanopia').value, `${mode}, protanopia`).toBeGreaterThanOrEqual(12);
      for (const other of ['signal', 'accent']) for (const colour of colours) {
        expect(smallestDifference([colour, tokens[other]![mode]]).value, `${mode}, against --${other}`).toBeGreaterThanOrEqual(20);
      }
    }
  });
});
