// Text normalisation shared by framework reference matching and quote verification (contract v2, course-contract-v2
// design §2 and §5). No imports: the institution's framework parsers and course-refs.mjs both use it, and course-refs.mjs
// imports the institution registry, so this must not import either (generic-adapters PR 3).
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * Normalisation shared by framework reference matching and quote verification: strip HTML tags, decode the common
 * entities, NFKC, lowercase, unify quote and dash characters, collapse all whitespace to one space, trim.
 */
export function normaliseText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:(amp|lt|gt|quot|#39|nbsp)|#(\d+)|#x([0-9a-f]+));/gi, (match, name, dec, hex) => {
      if (name) return ENTITIES[name.toLowerCase()];
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
