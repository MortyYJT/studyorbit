/** Colour palettes, applied as `data-palette` on <html>; the tokens live in style.css. */
export const palettes = ['mono', 'mist', 'pine', 'stone', 'morty'] as const;
export type Palette = (typeof palettes)[number];

/** Reads a stored palette id; anything unknown falls back to the default achromatic palette. */
export function parsePalette(value: string | null | undefined): Palette {
  return palettes.find(palette => palette === value) ?? 'mono';
}
