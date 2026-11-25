import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { smallestDifference } from './colour-math.js';
import { modes, pairContrast, pairs, quietPairs, readTokens, strayColours, weightTokens } from './palette-tokens.js';
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
    // A colour written out in any other custom property would be the same in both themes.
    expect(strayColours()).toEqual([]);
  });

  it('refuse a token that is declared a second time, in whatever form and under whatever selector', () => {
    const once = ':root { --text:light-dark(#111, #eee); }';
    expect(Object.keys(readTokens(once))).toEqual(['text']);
    for (const second of ['[data-theme="dark"] { --text:#fff; }', '[data-bg="image"] { --text:rgba(0, 0, 0, .5); }', '.card { --text: hsl(0 0% 100%); }',
      '.card { --text:var(--muted); }', '.card { --text:color-mix(in srgb, var(--muted) 50%, transparent); }', '.card { --text:white }',
      ':root { --text:light-dark(#222, #ddd); }']) {
      expect(() => readTokens(`${once}\n${second}`), second).toThrow(/--text is declared more than once/);
    }
    // A mention in a comment is not a declaration.
    expect(Object.keys(readTokens(`${once}\n/* --text:#fff; */`))).toEqual(['text']);
  });

  it('notice a colour written out in a custom property that is not a light-dark() token', () => {
    const found = (declaration: string) => strayColours(`.card { ${declaration} }`).length;
    for (const declaration of ['--edge:#fff;', '--edge:#0008;', '--edge:rgb(0 0 0 / .5);', '--edge:rgba(0, 0, 0, .5);', '--edge:hsl(0 0% 50%);', '--edge:oklch(60% 0.1 20);',
      '--edge:color(srgb 1 0 0);', '--edge:white;', '--edge:1px solid RebeccaPurple;', '--edge:color-mix(in srgb, red 50%, var(--text));']) {
      expect(found(declaration), declaration).toBe(1);
    }
    for (const declaration of ['--edge:var(--text);', '--edge:color-mix(in srgb, var(--surface) 50%, transparent);', '--gap:16px;', '--ease:cubic-bezier(.2,.8,.2,1);',
      '--font:-apple-system,"Segoe UI","Linen Sans",sans-serif;', '--edge:currentColor;', '--tan-line:var(--tan-ground);', 'color:#fff;']) {
      expect(found(declaration), declaration).toBe(0);
    }
  });

  it('keep every text, mark and edge the page draws at its WCAG floor, light and dark', () => {
    const failures: string[] = [];
    for (const mode of modes) for (const pair of pairs) {
      const ratio = pairContrast(tokens, mode, pair);
      if (ratio < pair.floor) failures.push(`${mode}: ${pair.what} (--${pair.ink}${pair.over ? ` over ${pair.over.join(' + ')}` : ''} against ${pair.on.join(' + ')}) is ${ratio.toFixed(2)}:1, under ${pair.floor}:1`);
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

  // The pairs above assume that the translucent fills never stack and that faint or alert text never sits on --active
  // (decision #521). These are the rules in style.css that make it so.
  describe('the rules that keep the fills from stacking', () => {
    const css = read('../web/src/style.css');
    const rule = (selector: string) => {
      const start = css.split('\n').find(line => line.trimStart().startsWith(`${selector} {`));
      expect(start, selector).toBeDefined();
      return start!;
    };

    it('press with the hover fill, never the darker one', () => {
      expect(rule('button:is(:hover,:active):enabled')).toContain('background:var(--hover)');
      expect(css).not.toContain('button:active:enabled { background');
      // The primary button keeps its own colours when pressed from the keyboard.
      expect(rule('button.primary:is(:hover,:active):enabled')).toContain('background:var(--accent-hover)');
    });

    it('lay the segmented track over the workspace colour and leave its unselected half clear', () => {
      expect(rule('.seg')).toContain('background:linear-gradient(var(--active), var(--active)), var(--ground)');
      expect(rule('.seg button:not([aria-pressed="true"]):is(:hover,:active):enabled')).toContain('background:none');
    });

    it('keep a hovered deadline chip opaque on its band', () => {
      expect(rule('button.due:is(:hover,:active):enabled')).toContain('background:linear-gradient(var(--hover), var(--hover)), var(--surface)');
    });

    it('add no fill to a row that already lies on the current-row fill', () => {
      expect(rule('.nav-item[aria-current="page"]:is(:hover,:active):enabled')).toContain('background:none');
    });

    it('keep the darker fill for a hovered plan block, which holds no faint or alert text', () => {
      expect(rule('.blk:is(:hover,:active):enabled')).toContain('background:var(--active)');
      // Faint text is set on placeholders, "No plan" and days outside the month; none of them is inside a plan block.
      const faint = css.split('\n').filter(line => line.includes('color:var(--faint)')).map(line => line.slice(0, line.indexOf('{')).trim());
      expect(faint).toEqual(['input::placeholder,textarea::placeholder', '.empty-day', '.cell.out .num']);
    });
  });

  it('gives the dialog backdrop a literal colour for browsers whose ::backdrop does not inherit custom properties', () => {
    expect(read('../web/src/style.css')).toContain('dialog::backdrop { background:var(--scrim, rgb(0 0 0 / 0.302)); }');
  });
});
