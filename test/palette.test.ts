import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { palettes, parsePalette } from '../web/src/palette.js';

describe('parsePalette', () => {
  it('keeps a known palette and falls back to mono otherwise', () => {
    expect(parsePalette('morty')).toBe('morty');
    expect(parsePalette('violet')).toBe('mono');
    expect(parsePalette(null)).toBe('mono');
  });

  it('matches the palette ids that index.html applies before the app mounts', () => {
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const list = /\[((?:'[a-z]+',?\s*)+)\]\.indexOf\(palette\)/.exec(html)?.[1];
    expect(list?.match(/[a-z]+/g)).toEqual([...palettes]);
  });
});
