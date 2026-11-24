// Colour arithmetic for the palette tests: parsing the forms style.css uses, alpha compositing, WCAG contrast,
// CIEDE2000 and a colour-vision-deficiency simulation. No dependency; sRGB throughout.

/** sRGB channels 0–255 and alpha 0–1. */
export type Colour = { r: number; g: number; b: number; a: number };
export type Deficiency = 'deuteranopia' | 'protanopia';

/** Parses `#rgb`, `#rrggbb` and `rgb(r g b / a)`, the only forms the tokens in style.css use. */
export function parseColour(text: string): Colour {
  const value = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  throw new Error(`Unsupported colour: ${text}`);
}

/** `top` laid over an opaque `bottom`. */
export function over(top: Colour, bottom: Colour): Colour {
  const mix = (upper: number, lower: number) => upper * top.a + lower * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

/** Lays each colour over the one before it; the first must be opaque. */
export function stack(...layers: Colour[]): Colour {
  return layers.reduce((bottom, top) => over(top, bottom));
}

export function toHex(colour: Colour): string {
  return `#${[colour.r, colour.g, colour.b].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

const linear = (channel: number) => { const unit = channel / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; };
const encoded = (unit: number) => 255 * (unit <= 0.0031308 ? unit * 12.92 : 1.055 * unit ** (1 / 2.4) - 0.055);

/** WCAG 2 relative luminance of an opaque colour. */
export function luminance(colour: Colour): number {
  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

/** WCAG 2 contrast ratio of two opaque colours, 1–21. */
export function contrast(first: Colour, second: Colour): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** CIE L*a*b* under D65. */
function lab(colour: Colour): [number, number, number] {
  const [r, g, b] = [linear(colour.r), linear(colour.g), linear(colour.b)];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference (Sharma, Wu and Dalal 2005). About 1 is just noticeable. */
export function deltaE(first: Colour, second: Colour): number {
  const [l1, a1, b1] = lab(first), [l2, a2, b2] = lab(second);
  const degrees = (radians: number) => radians * 180 / Math.PI, radians = (deg: number) => deg * Math.PI / 180;
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + g), ap2 = a2 * (1 + g);
  const c1 = Math.hypot(ap1, b1), c2 = Math.hypot(ap2, b2);
  const hue = (a: number, b: number) => a === 0 && b === 0 ? 0 : (degrees(Math.atan2(b, a)) + 360) % 360;
  const h1 = hue(ap1, b1), h2 = hue(ap2, b2);
  const dl = l2 - l1, dc = c2 - c1;
  let dh = c1 * c2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(dh / 2));
  const ml = (l1 + l2) / 2, mc = (c1 + c2) / 2;
  let mh = h1 + h2;
  if (c1 * c2 !== 0) mh = Math.abs(h1 - h2) <= 180 ? mh / 2 : mh < 360 ? (mh + 360) / 2 : (mh - 360) / 2;
  const t = 1 - 0.17 * Math.cos(radians(mh - 30)) + 0.24 * Math.cos(radians(2 * mh)) + 0.32 * Math.cos(radians(3 * mh + 6)) - 0.2 * Math.cos(radians(4 * mh - 63));
  const sl = 1 + 0.015 * (ml - 50) ** 2 / Math.sqrt(20 + (ml - 50) ** 2), sc = 1 + 0.045 * mc, sh = 1 + 0.015 * mc * t;
  const rotation = -2 * Math.sqrt(mc ** 7 / (mc ** 7 + 25 ** 7)) * Math.sin(radians(60 * Math.exp(-(((mh - 275) / 25) ** 2))));
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rotation * (dc / sc) * (dH / sh));
}

// Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB.
const deficiencyMatrix: Record<Deficiency, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};

/** How an opaque colour looks with a full colour-vision deficiency. */
export function simulate(colour: Colour, deficiency: Deficiency): Colour {
  const rgb = [linear(colour.r), linear(colour.g), linear(colour.b)];
  const [r, g, b] = deficiencyMatrix[deficiency].map(row => encoded(Math.min(1, Math.max(0, row[0]! * rgb[0]! + row[1]! * rgb[1]! + row[2]! * rgb[2]!)))) as [number, number, number];
  return { r, g, b, a: 1 };
}

/** The smallest difference between any two of `colours`, with the pair that has it. */
export function smallestDifference(colours: Colour[], deficiency?: Deficiency): { value: number; pair: [number, number] } {
  const seen = deficiency ? colours.map(colour => simulate(colour, deficiency)) : colours;
  let best = { value: Infinity, pair: [0, 0] as [number, number] };
  for (let i = 0; i < seen.length; i += 1) for (let j = i + 1; j < seen.length; j += 1) {
    const value = deltaE(seen[i]!, seen[j]!);
    if (value < best.value) best = { value, pair: [i, j] };
  }
  return best;
}
