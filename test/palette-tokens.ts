// The colour tokens of web/src/style.css and the pairs the page actually draws with them (decisions #512, #514, #521).
// test/palette.test.ts holds every pair to its floor; the table in docs/palette.md is printed from the same list.
import { readFileSync } from 'node:fs';
import { contrast, parseColour, stack, type Colour } from './colour-math.js';

export const modes = ['light', 'dark'] as const;
export type Mode = (typeof modes)[number];
export type Tokens = Record<string, Record<Mode, Colour>>;
export type Declaration = { name: string; value: string };

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

const stylesheet = () => readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8');

/** Every custom-property declaration in a stylesheet, under any selector and with any value, comments left out. */
export function readDeclarations(css = stylesheet()): Declaration[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)\s*:\s*([^;{}]*)/g)]
    .map(match => ({ name: match[1]!, value: match[2]!.trim() }));
}

/**
 * The colour tokens: every custom property written as a `light-dark()` pair, by name without the dashes. Throws when a
 * token's name is declared anywhere else too, whatever the second value looks like (`rgba()`, `var()`, a colour name),
 * so an override under another selector cannot hide here.
 */
export function readTokens(css = stylesheet()): Tokens {
  const declarations = readDeclarations(css);
  const tokens: Tokens = {};
  for (const { name, value } of declarations) {
    if (!value.startsWith('light-dark(')) continue;
    if (declarations.filter(other => other.name === name).length > 1) throw new Error(`--${name} is declared more than once`);
    const pair = splitPair(value.slice('light-dark('.length, value.lastIndexOf(')')));
    tokens[name] = { light: parseColour(pair[0]), dark: parseColour(pair[1]) };
  }
  return tokens;
}

const namedColours = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse '
  + 'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta '
  + 'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet '
  + 'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green '
  + 'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan '
  + 'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey '
  + 'lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen '
  + 'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive '
  + 'olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple '
  + 'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ');
const literalColour = new RegExp(`#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|(?<![\\w-])(?:${namedColours.join('|')})(?![\\w-])`, 'i');

/**
 * Custom properties outside the tokens that hold a colour written out (hex, a colour function, a colour name). Such a
 * value would be the same in light and dark. Values built from the tokens (`var()`, `color-mix()` of them) are fine.
 */
export function strayColours(css = stylesheet()): string[] {
  return readDeclarations(css)
    .filter(({ value }) => !value.startsWith('light-dark('))
    // Quoted strings (font names) and token references are not colours.
    .filter(({ value }) => literalColour.test(value.replace(/"[^"]*"|'[^']*'/g, '').replace(/var\(\s*--[a-z0-9-]+/gi, 'var(')))
    .map(({ name, value }) => `--${name}:${value}`);
}

/** A place something is drawn: token names from the bottom layer up (the first is opaque). */
export type Surface = string[];
export type Pair = {
  /** What is drawn, in words for the documentation. */
  what: string;
  /** The token it is drawn in. */
  ink: string;
  /** What it is seen against. */
  on: Surface;
  /**
   * What a translucent ink is painted over, when that is not `on`: a border is painted over its own element's
   * background, and is then seen against the surface outside the element or against the element's inside.
   */
  over?: Surface;
  /** WCAG floor: 4.5 for text, 3 for large text, marks and edges that carry meaning. */
  floor: number;
};

// The translucent fills never stack (decision #521): a place is a base, or a base with one of --raised, --hover or
// --active on it. The optional gradient background is measured where it is strongest, --tint over the workspace.
const sidebar = ['sidebar'], workspace = ['ground'], gradient = ['ground', 'tint'], card = ['surface'], dialog = ['float'];
const surfaces: Record<string, Surface> = {
  'sidebar': sidebar, 'sidebar, hovered row': [...sidebar, 'hover'], 'sidebar, current row': [...sidebar, 'active'],
  'workspace': workspace, 'workspace, quiet fill': [...workspace, 'raised'], 'workspace, hovered row': [...workspace, 'hover'],
  'gradient background': gradient, 'gradient background, quiet fill': [...gradient, 'raised'], 'gradient background, hovered row': [...gradient, 'hover'],
  'card': card, 'card, quiet fill': [...card, 'raised'], 'card, hovered row': [...card, 'hover'],
  'card, current row or hovered plan block': [...card, 'active'],
  // The track is laid over the workspace colour wherever the control sits, so it is the same on a dialog or a gradient.
  'segmented track': [...workspace, 'active'],
  'dialog': dialog, 'dialog, quiet fill': [...dialog, 'raised'], 'dialog, hovered row': [...dialog, 'hover'],
  'field': ['field'],
};

function each(what: string, ink: string, names: string[], floor: number, over?: Surface): Pair[] {
  return names.map(name => ({ what: `${what} on ${name}`, ink, on: surfaces[name]!, floor, ...(over ? { over } : {}) }));
}

const everywhere = Object.keys(surfaces);
/** Every pairing the stylesheet produces, with its floor. */
export const pairs: Pair[] = [
  ...each('Text', 'text', everywhere, 4.5),
  ...each('Muted text', 'muted', everywhere, 4.5),
  // Placeholders, "nothing planned", days outside the month (a button, so also hovered).
  ...each('Faint text', 'faint', ['card', 'card, hovered row', 'field'], 4.5),
  // 「无出处」 and conflict marks are 11px text; they sit in list rows (plain, open or hovered), the weight strip and the drawer.
  ...each('Alert text', 'signal', ['workspace', 'workspace, quiet fill', 'workspace, hovered row', 'gradient background', 'gradient background, quiet fill',
    'gradient background, hovered row', 'card', 'card, quiet fill', 'card, hovered row', 'dialog'], 4.5),
  { what: 'Text on the primary button, today\'s date and the toast', ink: 'on-accent', on: ['accent'], floor: 4.5 },
  { what: 'Text on the primary button, hovered or pressed', ink: 'on-accent', on: ['accent-hover'], floor: 4.5 },
  { what: 'Selected text', ink: 'text', on: ['selection'], floor: 4.5 },
  { what: 'Selected muted text', ink: 'muted', on: ['selection'], floor: 4.5 },
  // Marks and edges that carry meaning on their own: 3:1 against what they sit on.
  ...each('Alert dot', 'signal', ['workspace', 'gradient background', 'card', 'card, quiet fill', 'card, hovered row', 'dialog', 'dialog, quiet fill', 'dialog, hovered row'], 3),
  ...each('Earned arc, today marker, progress, deadline bar', 'accent', ['card', 'card, quiet fill', 'dialog'], 3),
  { what: 'Earned arc against the rest of the ring', ink: 'accent', on: ['track'], floor: 3 },
  // A field's edge is painted over the field's own fill; it has to stand out from what is outside and from the inside.
  ...each('Field edge', 'border-strong', ['workspace', 'gradient background', 'card', 'dialog'], 3, ['field']),
  { what: 'Field edge against the inside of the field', ink: 'border-strong', on: ['field'], floor: 3 },
  { what: 'Dashed edge of a task added by hand, on card', ink: 'border-strong', on: card, floor: 3 },
  ...each('Focus ring', 'focus', ['sidebar', 'workspace', 'gradient background', 'card', 'dialog', 'field'], 3),
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

/** Contrast of a pair in one mode; a translucent ink is first laid over what it is painted on. */
export function pairContrast(tokens: Tokens, mode: Mode, pair: Pair): number {
  const token = tokens[pair.ink];
  if (!token) throw new Error(`Unknown token --${pair.ink}`);
  return contrast(stack(surfaceColour(tokens, mode, pair.over ?? pair.on), token[mode]), surfaceColour(tokens, mode, pair.on));
}

export const weightTokens = [0, 1, 2, 3, 4, 5].map(index => `weight-${index}`);
