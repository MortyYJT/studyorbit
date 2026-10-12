import { expect, it } from 'vitest';
import { hash, normalizeCitation, validateCitation } from '../../src/citations/exact.js';
const source = (text: string) => ({ sourceItemId: 'synthetic-source', text, locator: 'page:2', page: 2, sourceHash: hash(text) });
const cite = (quote: string) => ({ sourceItemId: 'synthetic-source', quote, locator: 'page:2' });
it.each([
  ['😀  Ａ\n\t“ﬁne” end', 'A "fine"', 4, 12],
  ['prefix e\u0301 suffix', 'é', 7, 9],
  ['😀  fragment fragment', 'fragment', 4, 12],
  ['  ﬃ  ', 'ffi', 2, 3],
  ['x ‘quote’ y', "'quote'", 2, 9],
])('maps normalized membership to original UTF-16: %s', (text, quote, offset, end) => {
  const result = validateCitation(cite(quote), source(text));
  expect(result).toEqual({ ...cite(quote), offset, end, sourceHash: hash(text), page: 2 });
  expect(normalizeCitation(text.slice(offset, end))).toBe(normalizeCitation(quote));
});
it.each(['', ' \n\t ', 'invented', 'FRAGMENT', 'frag ment'])('rejects empty or nonexact quote %j', quote => {
  expect(() => validateCitation(cite(quote), source('fragment'))).toThrow(/citation/i);
});
it('rejects forged citation metadata, stale hash and inconsistent PDF provenance', () => {
  for (const change of [{ offset: 0 }, { end: 8 }, { sourceHash: hash('fragment') }, { page: 2 }, { text: 'fragment' }, { sourceItemId: 'other' }, { locator: 'page:3' }]) {
    expect(() => validateCitation({ ...cite('fragment'), ...change }, source('fragment'))).toThrow(/citation/i);
  }
  for (const change of [{ sourceHash: hash('old') }, { page: 3 }, { sourceItemId: 'other' }]) {
    expect(() => validateCitation(cite('fragment'), { ...source('fragment'), ...change })).toThrow(/citation/i);
  }
});
