// The colour tokens of web/src/style.css and the pairs the page actually draws with them (decisions #512 and #514).
// test/palette.test.ts holds every pair to its floor; the table in docs/palette.md is printed from the same list.
import { readFileSync } from 'node:fs';
import { contrast, parseColour, stack, type Colour } from './colour-math.js';

export const modes = ['light', 'dark'] as const;
export type Mode = (typeof modes)[number];
export type Tokens = Record<string, Record<Mode, Colour>>;

/** Splits `light-dark(a, b)` at its top-level comma. */
function splitPair(inner: string): [string, string] {
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') depth += 1; else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) return [inner.slice(0, index), inner.slice(index + 1)];
  }
  throw new Error(`light-dark() needs two values: ${inner}`);
}

/**
 * Every custom property in the stylesheet whose value is a colour or a `light-dark()` pair of colours, by name without
 * the dashes. Throws when a token is declared twice, so a second definition (a per-theme override) cannot hide here.
 */
export function readTokens(css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8')): Tokens {
  const tokens: Tokens = {};
  for (const match of css.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)\s*:\s*((?:light-dark\(|#|rgb\()[^;}]*)[;}]/g)) {
    const name = match[1]!, value = match[2]!.trim();
    if (tokens[name]) throw new Error(`--${name} is declared more than once`);
    const pair = value.startsWith('light-dark(') ? splitPair(value.slice('light-dark('.length, value.lastIndexOf(')'))) : [value, value] as const;
    tokens[name] = { light: parseColour(pair[0]), dark: parseColour(pair[1]) };
  }
  return tokens;
}

/** A place something is drawn: token names from the bottom layer up (the first is opaque). */
export type Surface = string[];
export type Pair = {
  /** What is drawn, in words for the documentation. */
  what: string;
  /** The token it is drawn in. */
  ink: string;
  on: Surface;
  /** WCAG floor: 4.5 for text, 3 for large text, marks and edges that carry meaning. */
  floor: number;
};

const sidebar = ['sidebar'], workspace = ['ground'], card = ['surface'], dialog = ['float'];
const surfaces: Record<string, Surface> = {
  'sidebar': sidebar, 'sidebar, hovered row': [...sidebar, 'hover'], 'sidebar, current row': [...sidebar, 'active'],
  'workspace': workspace, 'workspace, hovered button': [...workspace, 'hover'],
  // The optional gradient background at its strongest point.
  'workspace, gradient': ['tint'], 'workspace, gradient, hovered button': ['tint', 'hover'],
  'card': card, 'card, quiet fill': [...card, 'raised'], 'card, hovered row': [...card, 'hover'], 'card, pressed or segmented track': [...card, 'active'],
  'dialog': dialog, 'dialog, quiet fill': [...dialog, 'raised'], 'dialog, hovered row': [...dialog, 'hover'], 'dialog, segmented track': [...dialog, 'active'],
  'field': ['field'],
};

function each(what: string, ink: string, names: string[], floor: number): Pair[] {
  return names.map(name => ({ what: `${what} on ${name}`, ink, on: surfaces[name]!, floor }));
}

const everywhere = Object.keys(surfaces);
/** Every pairing the stylesheet produces, with its floor. */
export const pairs: Pair[] = [
  ...each('Text', 'text', everywhere, 4.5),
  ...each('Muted text', 'muted', everywhere, 4.5),
  // Placeholders, "nothing planned", days outside the month, the second line of a past day's block.
  ...each('Faint text', 'faint', ['card', 'card, quiet fill', 'field', 'dialog'], 4.5),
  // 「无出处」 and conflict marks are 11px text; they sit in list rows, the weight strip and the drawer's plain rows.
  ...each('Alert text', 'signal', ['workspace', 'workspace, gradient', 'card', 'card, quiet fill', 'card, hovered row', 'dialog'], 4.5),
  { what: 'Text on the primary button, today\'s date and the toast', ink: 'on-accent', on: ['accent'], floor: 4.5 },
  { what: 'Text on the primary button, hovered', ink: 'on-accent', on: ['accent-hover'], floor: 4.5 },
  { what: 'Selected text', ink: 'text', on: ['selection'], floor: 4.5 },
  { what: 'Selected muted text', ink: 'muted', on: ['selection'], floor: 4.5 },
  // Marks and edges that carry meaning on their own: 3:1 against what they sit on.
  ...each('Alert dot', 'signal', ['sidebar', 'workspace', 'workspace, gradient', 'card', 'card, quiet fill', 'dialog'], 3),
  ...each('Earned arc, today marker, progress, deadline bar', 'accent', ['card', 'card, quiet fill', 'dialog'], 3),
  { what: 'Earned arc against the rest of the ring', ink: 'accent', on: ['track'], floor: 3 },
  ...each('Field edge', 'border-strong', ['workspace', 'card', 'dialog'], 3),
  ...each('Focus ring', 'focus', ['sidebar', 'workspace', 'workspace, gradient', 'card', 'dialog', 'field'], 3),
  ...[0, 1, 2, 3, 4, 5].flatMap(index => each(`Weight colour ${index + 1}`, `weight-${index}`, ['card', 'card, quiet fill'], 3)),
];

/**
 * Pairs that stay under 3:1 on purpose, with the floor they are held to so they cannot fade further. The unfilled part
 * of a ring or bar is the absence of a mark; the filled part and the figure beside it carry the reading.
 */
export const quietPairs: Pair[] = [
  { what: 'Unfilled part of the ring on a card', ink: 'track', on: card, floor: 1.3 },
  { what: 'Unfilled part of the weight bar on the strip', ink: 'track', on: [...card, 'raised'], floor: 1.2 },
];

/** The opaque colour a surface comes to in one mode. */
export function surfaceColour(tokens: Tokens, mode: Mode, surface: Surface): Colour {
  return stack(...surface.map(name => {
    const token = tokens[name];
    if (!token) throw new Error(`Unknown token --${name}`);
    return token[mode];
  }));
}

/** Contrast of a pair in one mode; a translucent ink is laid over the surface first. */
export function pairContrast(tokens: Tokens, mode: Mode, pair: Pair): number {
  const ground = surfaceColour(tokens, mode, pair.on);
  const token = tokens[pair.ink];
  if (!token) throw new Error(`Unknown token --${pair.ink}`);
  return contrast(stack(ground, token[mode]), ground);
}

export const weightTokens = [0, 1, 2, 3, 4, 5].map(index => `weight-${index}`);
