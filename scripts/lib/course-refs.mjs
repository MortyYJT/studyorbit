// Contract v2 helpers (openspec/changes/course-contract-v2/design.md §2–§4, §6): Handbook components, text normalisation,
// slugs, deterministic assessment IDs, fact back-fill from collected data, the legacy ID map and the stored document.
// Pure functions; no I/O.
import { CourseDocumentV2Schema } from '../../shared/course-data.ts';
import { parseHandbookComponents, parseHandbookRows } from '../institutions/unimelb/handbook-parse.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * Normalisation shared by Handbook reference matching and quote verification: strip HTML tags, decode the common
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

// The Handbook parsers moved to the UniMelb framework source (openspec change generic-adapters, design §4); they are
// re-exported here until the remaining callers take them from the institution.
export { parseHandbookComponents, parseHandbookRows };

/** NFKC, lowercase, every run of non-alphanumeric characters (Unicode letters and digits count) as one `-`; empty → `item`. */
export function slug(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'item';
}

/** Total order of reference IDs: all-digit IDs first in numeric order, then the others in code-point order. */
export function compareIds(a, b) {
  const digitsA = /^\d+$/.test(a), digitsB = /^\d+$/.test(b);
  if (digitsA !== digitsB) return digitsA ? -1 : 1;
  if (digitsA) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (diff) return diff;
  }
  return left.length - right.length;
}

/** The primary (smallest) reference ID on `platform`, or null. */
export function primaryRef(refs, platform) {
  const ids = refs.filter(ref => ref.platform === platform).map(ref => ref.id);
  return ids.length ? ids.sort(compareIds)[0] : null;
}

const ID_PLATFORMS = [['canvas', id => `canvas:${id}`], ['ed', id => `ed:${id}`], ['canvas-group', id => `canvas-group:${id}`], ['handbook', id => `handbook:${slug(id)}`]];

/** Base ID from the highest-priority platform, and whether that base ID may be shared by several items. */
function baseId(item) {
  for (const [platform, format] of ID_PLATFORMS) {
    const id = primaryRef(item.refs, platform);
    if (id !== null) return { id: format(id), repeatable: platform === 'canvas-group' || platform === 'handbook' };
  }
  return { id: `group:${slug(item.name)}`, repeatable: true };
}

/**
 * Deterministic IDs for model assessments `{ key, parentKey, refs, name }` (design §3). Handbook references must already
 * hold canonical component names. A repeatable base ID (Canvas group, Handbook, group) shared by several items becomes
 * `<base>:<slug(name)>` on every one of them. Returns `{ ids, parentIds }` in input order; an unknown parentKey gives null.
 * IDs may still repeat; the caller reports that as a validation issue.
 */
export function generateIds(assessments) {
  const bases = assessments.map(baseId);
  const counts = new Map();
  for (const base of bases) counts.set(base.id, (counts.get(base.id) ?? 0) + 1);
  const ids = bases.map((base, index) => (base.repeatable && counts.get(base.id) > 1 ? `${base.id}:${slug(assessments[index].name)}` : base.id));
  const byKey = new Map(assessments.map((item, index) => [item.key, ids[index]]));
  return { ids, parentIds: assessments.map(item => (item.parentKey === null ? null : byKey.get(item.parentKey) ?? null)) };
}

const list = value => (Array.isArray(value) ? value : []);

/**
 * Lookup tables over the collected data. A collection that is missing or unavailable has empty tables, so every
 * reference to it fails. Handbook references need at least one parsed component.
 */
export function indexCollected({ canvas, ed, handbook } = {}) {
  const canvasOk = canvas && typeof canvas === 'object' && canvas.status !== 'unavailable';
  const edOk = ed && typeof ed === 'object' && !['unavailable', 'not_found'].includes(ed.status);
  const handbookOk = handbook && typeof handbook === 'object' && handbook.status === 'available';
  const components = handbookOk ? parseHandbookComponents(handbook.text) : [];
  const assignments = canvasOk ? list(canvas.assignments).filter(item => item && item.id !== undefined && item.id !== null) : [];
  return {
    assignments: new Map(assignments.map(item => [String(item.id), item])),
    groups: new Map((canvasOk ? list(canvas.groups) : []).filter(item => item && item.id !== undefined && item.id !== null).map(item => [String(item.id), item])),
    lessons: new Map((edOk ? list(ed.lessons) : []).filter(item => item && item.id !== undefined && item.id !== null).map(item => [String(item.id), item])),
    scores: new Map((edOk ? list(ed.scores) : []).filter(item => item && item.lessonId !== undefined).map(item => [String(item.lessonId), item])),
    handbookUrl: handbookOk && typeof handbook.url === 'string' ? handbook.url : null,
    components,
    componentsByName: new Map(components.map(component => [normaliseText(component.name), component])),
  };
}

/** The reference in canonical form (a Handbook reference gets the component's own name), or null when it was not collected. */
export function resolveRef(index, ref) {
  switch (ref.platform) {
    case 'canvas': return index.assignments.has(ref.id) ? ref : null;
    case 'canvas-group': return index.groups.has(ref.id) ? ref : null;
    case 'ed': return index.lessons.has(ref.id) ? ref : null;
    case 'handbook': {
      const component = index.componentsByName.get(normaliseText(ref.id));
      return component ? { platform: 'handbook', id: component.name } : null;
    }
    default: return null;
  }
}

/** Canonical references of one model assessment, de-duplicated in output order; unresolved references are dropped. */
export function canonicalRefs(index, refs) {
  const seen = new Set(), out = [];
  for (const ref of refs) {
    const resolved = resolveRef(index, ref);
    const key = resolved && `${resolved.platform}\u0000${resolved.id}`;
    if (!resolved || seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

const STATUS_RANK = { unknown: 0, not_started: 1, submitted: 2, graded: 3 };
const finite = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const httpUrl = value => {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try { new URL(value); return value; } catch { return null; }
};

function canvasStatus(submission) {
  if (!submission || typeof submission !== 'object') return 'unknown';
  const state = submission.workflow_state;
  if (state === 'graded') return 'graded';
  if (state === 'submitted' || state === 'pending_review') return 'submitted';
  if (state === 'unsubmitted' && !submission.submitted_at) return 'not_started';
  return 'unknown';
}

function edStatus(record) {
  if (!record) return 'unknown';
  if (record.status === 'graded') return 'graded';
  if (record.status === 'not_available' && record.submittedAt) return 'submitted';
  if (record.status === 'no_final_submission') return 'not_started';
  return 'unknown';
}

/**
 * Due date, score / maximum pair and status from the primary Canvas assignment and Ed lesson (design §4). `refs` are
 * canonical references. The pair comes from one source: graded Canvas, else graded Ed, else no score and the Canvas
 * maximum; a score above its maximum keeps the score and drops the maximum. Status is the most advanced source value.
 */
export function backfillFacts(index, refs) {
  const canvasId = primaryRef(refs, 'canvas'), edId = primaryRef(refs, 'ed');
  const assignment = canvasId === null ? null : index.assignments.get(canvasId) ?? null;
  const lesson = edId === null ? null : index.lessons.get(edId) ?? null;
  const record = lesson ? index.scores.get(edId) ?? null : null;
  const due = (typeof assignment?.due_at === 'string' && assignment.due_at) || (typeof lesson?.due === 'string' && lesson.due) || null;
  const canvasScore = assignment?.submission?.workflow_state === 'graded' ? finite(assignment.submission.score) : null;
  const edScore = record?.status === 'graded' ? finite(record.score) : null;
  let score = null, maxScore = finite(assignment?.points_possible);
  if (canvasScore !== null) score = canvasScore;
  else if (edScore !== null) { score = edScore; maxScore = finite(record.maxScore); }
  if (score !== null && maxScore !== null && score > maxScore) maxScore = null;
  const statuses = [assignment ? canvasStatus(assignment.submission) : 'unknown', lesson ? edStatus(record) : 'unknown'];
  const status = statuses.reduce((best, value) => (STATUS_RANK[value] > STATUS_RANK[best] ? value : best), 'unknown');
  return { due, score, maxScore, status };
}

/** One source per canonical reference, built by code: link to the assignment, lesson or Handbook page; none for a group. */
export function buildSources(index, refs) {
  return refs.map(ref => {
    if (ref.platform === 'canvas') return { platform: 'canvas', url: httpUrl(index.assignments.get(ref.id)?.html_url), evidence: null };
    if (ref.platform === 'ed') return { platform: 'ed', url: httpUrl(index.lessons.get(ref.id)?.url), evidence: null };
    if (ref.platform === 'handbook') return { platform: 'handbook', url: httpUrl(index.handbookUrl), evidence: null };
    return { platform: 'canvas', url: null, evidence: null };
  });
}

const V1_CANVAS_URL = /\/courses\/[^/]+\/assignments\/(\d+)(?:[/?#]|$)/;
const V1_ED_URL = /\/lessons\/(\d+)(?:[/?#]|$)/;

// Platform identities of an earlier assessment: v2 `canvas`/`ed` refs, or for v1 source URLs and platform-shaped IDs.
// A bare-digit v1 ID is returned as `{ bare: digits }` and resolved later (Canvas first, then Ed).
function previousIdentities(item, version) {
  if (version === 2) return list(item.refs).filter(ref => ref.platform === 'canvas' || ref.platform === 'ed').map(ref => ({ platform: ref.platform, id: ref.id }));
  const out = [];
  for (const source of list(item.sources)) {
    if (typeof source?.url !== 'string') continue;
    const canvasMatch = source.platform === 'canvas' ? V1_CANVAS_URL.exec(source.url) : null;
    const edMatch = source.platform === 'ed' ? V1_ED_URL.exec(source.url) : null;
    if (canvasMatch) out.push({ platform: 'canvas', id: canvasMatch[1] });
    if (edMatch) out.push({ platform: 'ed', id: edMatch[1] });
  }
  const shaped = /^(?:(canvas|ed)[-:])?(\d+)$/.exec(String(item.id));
  if (shaped) out.push(shaped[1] ? { platform: shaped[1], id: shaped[2] } : { bare: shaped[2] });
  return out;
}

/**
 * Every Canvas assignment and Ed lesson identity of an assessment of either version (design §7): `canvas`/`ed` refs, IDs
 * parsed from source URLs, and a platform-shaped ID. A bare-digit ID is returned as `{ bare: digits }` (Canvas first, then Ed).
 */
export function platformIdentities(item) {
  const fromRefs = list(item?.refs).filter(ref => ref && (ref.platform === 'canvas' || ref.platform === 'ed') && typeof ref.id === 'string')
    .map(ref => ({ platform: ref.platform, id: ref.id }));
  return [...fromRefs, ...previousIdentities(item, 1)];
}

/**
 * Earlier assessment ID → current ID (design §6): equal IDs are paired first and excluded; then platform identity (for v1,
 * a group number ID matches `canvas-group:<n>` before anything else); then a name slug unique among the remaining items
 * on both sides. Only one-to-one pairs whose ID changed are kept. An earlier
 * v2 map is carried forward and composed; entries whose target is gone, or whose source is a current ID, are dropped.
 * `previous` is a stored v1/v2 document or null; `current` has `assessments: [{ id, name, refs }]`.
 */
export function buildLegacyIds(previous, current) {
  if (!previous || !Array.isArray(previous.assessments)) return {};
  const currentItems = list(current?.assessments);
  const currentIds = new Set(currentItems.map(item => item.id));
  const prev = previous.assessments.filter(item => !currentIds.has(item.id));
  const prevIds = new Set(previous.assessments.map(item => item.id));
  const cur = currentItems.filter(item => !prevIds.has(item.id));
  const owner = new Map();
  for (const item of cur) for (const ref of list(item.refs)) if (ref.platform === 'canvas' || ref.platform === 'ed') owner.set(`${ref.platform}\u0000${ref.id}`, item);
  const find = (platform, id) => owner.get(`${platform}\u0000${id}`);

  // A v1 group parent's ID is its bare Canvas assignment-group number, and its source links point at its children, so a
  // group match by ID is decisive (decision #385): `canvas-group-<n>` / `canvas-group:<n>`, or bare digits with no
  // `canvas:<n>`, preferring the group over `ed:<n>` only when the earlier item is a parent.
  const groups = new Map(cur.filter(item => /^canvas-group:\d+$/.test(item.id)).map(item => [item.id.slice('canvas-group:'.length), item]));
  const parents = new Set(previous.assessments.map(item => item.parentId).filter(id => typeof id === 'string'));
  const groupOf = item => {
    if (previous.version === 2) return undefined;
    const id = String(item.id);
    const shaped = /^canvas-group[-:](\d+)$/.exec(id);
    if (shaped) return groups.get(shaped[1]);
    if (!/^\d+$/.test(id) || find('canvas', id) || (find('ed', id) && !parents.has(item.id))) return undefined;
    return groups.get(id);
  };

  const candidates = new Map();
  for (const item of prev) {
    const group = groupOf(item);
    if (group) { candidates.set(item, new Set([group])); continue; }
    const found = new Set();
    for (const identity of previousIdentities(item, previous.version)) {
      const match = identity.bare === undefined ? find(identity.platform, identity.id) : find('canvas', identity.bare) ?? find('ed', identity.bare);
      if (match) found.add(match);
    }
    candidates.set(item, found);
  }
  const claimed = new Set([...candidates.values()].flatMap(found => [...found]));
  const count = items => items.reduce((map, item) => map.set(slug(item.name), (map.get(slug(item.name)) ?? 0) + 1), new Map());
  const prevSlugs = count(prev), curSlugs = count(cur);
  for (const item of prev) {
    if (candidates.get(item).size) continue;
    const name = slug(item.name);
    if (prevSlugs.get(name) !== 1 || curSlugs.get(name) !== 1) continue;
    const match = cur.find(other => slug(other.name) === name);
    if (!claimed.has(match)) candidates.get(item).add(match);
  }

  const targets = new Map();
  // Count every candidate of every earlier item: a current item matched by several earlier items stays unmapped.
  for (const found of candidates.values()) for (const match of found) targets.set(match, (targets.get(match) ?? 0) + 1);
  const pairs = new Map();
  for (const [item, found] of candidates) {
    if (found.size !== 1) continue;
    const [match] = found;
    if (targets.get(match) === 1) pairs.set(item.id, match.id);
  }

  // Maps, not objects, so an ID such as `__proto__` stays an ordinary key.
  const result = new Map();
  if (previous.version === 2 && previous.legacyIds && typeof previous.legacyIds === 'object') {
    for (const [from, to] of Object.entries(previous.legacyIds)) {
      const target = pairs.get(to) ?? to;
      if (currentIds.has(target) && !currentIds.has(from) && from !== target) result.set(from, target);
    }
  }
  for (const [from, to] of pairs) result.set(from, to);
  return Object.fromEntries(result);
}

/**
 * Stored course document v2 from a validated model output (design §1, §3, §4, §6). `collected` is `{ canvas, ed, handbook }`;
 * `previous` is the newest valid earlier document of the course (v1 or v2) or null. Weights, rules and their quotes are kept
 * as given, except that a quote for a null field is dropped; `unsourced` stays empty until quote verification runs.
 * Throws when a reference was not collected or the result breaks the stored schema (the output was not validated).
 */
export function buildStoredDocument(modelDocument, collected, previous) {
  const index = indexCollected(collected);
  for (const item of modelDocument.assessments) for (const ref of item.refs) {
    if (!resolveRef(index, ref)) throw new Error(`reference not collected: ${ref.platform} ${ref.id}`);
  }
  const items = modelDocument.assessments.map(item => ({ ...item, refs: canonicalRefs(index, item.refs) }));
  const { ids, parentIds } = generateIds(items);
  const assessments = items.map((item, i) => ({
    id: ids[i], name: item.name, kind: item.kind, nature: item.nature, parentId: parentIds[i],
    weight: item.weight, ...backfillFacts(index, item.refs), scoring: item.scoring, rule: item.rule,
    sources: buildSources(index, item.refs), refs: item.refs,
    weightQuote: item.weight === null ? null : item.weightQuote, ruleQuote: item.rule === null ? null : item.ruleQuote, unsourced: [],
  }));
  const document = {
    version: 2, course: { ...modelDocument.course }, assessments,
    materials: modelDocument.materials.map(material => ({ ...material })), legacyIds: {},
  };
  document.legacyIds = buildLegacyIds(previous, document);
  const parsed = CourseDocumentV2Schema.safeParse(document);
  if (!parsed.success) throw new Error(`stored document invalid: ${parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/**
 * Text form of a Canvas group's numeric drop rules (decision #280), e.g. `drop lowest 2; never drop Quiz 1`.
 * Given to the model as `rulesText` and used as a quote corpus unit. Empty when the group has no rules.
 */
export function renderGroupRules(group, assignments) {
  const rules = group?.rules && typeof group.rules === 'object' ? group.rules : {};
  const parts = [];
  if (Number.isInteger(rules.drop_lowest) && rules.drop_lowest > 0) parts.push(`drop lowest ${rules.drop_lowest}`);
  if (Number.isInteger(rules.drop_highest) && rules.drop_highest > 0) parts.push(`drop highest ${rules.drop_highest}`);
  for (const id of list(rules.never_drop)) {
    const assignment = list(assignments).find(item => item && String(item.id) === String(id));
    parts.push(`never drop ${typeof assignment?.name === 'string' && assignment.name ? assignment.name : id}`);
  }
  return parts.join('; ');
}
