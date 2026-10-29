import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backgroundFileProblem, backgroundModes, defaultBackground, fitWithin, parseBackground, surfaceAlpha } from '../web/src/background.js';

describe('parseBackground', () => {
  it('falls back to the defaults for missing or malformed values', () => {
    expect(parseBackground(null)).toEqual(defaultBackground);
    expect(parseBackground('not json')).toEqual(defaultBackground);
    expect(parseBackground('[1,2]')).toEqual(defaultBackground);
    expect(parseBackground('{"mode":"video","visibility":"high"}')).toEqual(defaultBackground);
  });

  it('keeps valid settings and clamps numbers into their ranges', () => {
    expect(parseBackground(JSON.stringify({ mode: 'image', visibility: 40, blur: 8, cardOpacity: 80 })))
      .toEqual({ mode: 'image', visibility: 40, blur: 8, cardOpacity: 80 });
    expect(parseBackground(JSON.stringify({ mode: 'solid', visibility: 140, blur: -3, cardOpacity: 20 })))
      .toEqual({ mode: 'solid', visibility: 100, blur: 0, cardOpacity: 70 });
    expect(parseBackground(JSON.stringify({ mode: 'image', visibility: 33.6, blur: 99, cardOpacity: 100.4 })))
      .toEqual({ mode: 'image', visibility: 34, blur: 24, cardOpacity: 100 });
  });
});

describe('background helpers', () => {
  it('refuses unsupported or oversized uploads', () => {
    expect(backgroundFileProblem({ type: 'image/gif', size: 10 })).toBe('type');
    expect(backgroundFileProblem({ type: 'image/png', size: 15 * 1024 * 1024 + 1 })).toBe('size');
    expect(backgroundFileProblem({ type: 'image/webp', size: 15 * 1024 * 1024 })).toBeNull();
  });

  it('downscales to a 2560 px longest edge and never upscales', () => {
    expect(fitWithin(5120, 2880)).toEqual({ width: 2560, height: 1440 });
    expect(fitWithin(3000, 6000)).toEqual({ width: 1280, height: 2560 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('applies card opacity only in image mode', () => {
    expect(surfaceAlpha({ ...defaultBackground, mode: 'image', cardOpacity: 80 })).toBe(80);
    expect(surfaceAlpha({ ...defaultBackground, mode: 'gradient', cardOpacity: 80 })).toBe(100);
  });

  it('matches the modes that index.html applies before the app mounts', () => {
    const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
    const list = /\[((?:'[a-z]+',?\s*)+)\]\.indexOf\(background\.mode\)/.exec(html)?.[1];
    expect(list?.match(/[a-z]+/g)).toEqual([...backgroundModes]);
  });
});
